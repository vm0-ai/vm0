#!/usr/bin/env tsx

import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { delay } from "signal-timers";
import {
  storedExecutionContextSchema,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";

import { closeDbPool, db } from "../lib/db";
import {
  decryptPersistentSecretValueWithMode,
  encryptPersistentSecretValueWithMode,
  inspectPersistentSecretCiphertext,
  type StoredSecretCiphertextFormat,
  type StoredSecretWriteMode,
} from "../signals/services/crypto.utils";
import {
  decryptQueuedRunnerJobPayloadWithMode,
  encryptQueuedRunnerJobPayloadWithMode,
} from "../signals/services/agent-run-queue-payload.service";
import { settle } from "../signals/utils";
import { nowDate } from "../lib/time";

interface MigrationArgs {
  readonly dryRun: boolean;
  readonly reportOnly: boolean;
  readonly mode: Exclude<StoredSecretWriteMode, "legacy">;
  readonly batchSize: number;
}

interface CiphertextCounts {
  readonly legacy: number;
  readonly dual: number;
  readonly kms: number;
}

interface MigrationReport {
  readonly name: string;
  readonly before: CiphertextCounts;
  readonly migrated: number;
  readonly after: CiphertextCounts;
}

interface KeyedEncryptedRow {
  readonly key: string;
  readonly encrypted: string | null;
}

type SelectBatch = (
  cursor: string | undefined,
  batchSize: number,
) => Promise<readonly KeyedEncryptedRow[]>;

type UpdateEncryptedRow = (
  row: KeyedEncryptedRow,
  encrypted: string,
) => Promise<number>;

const DEFAULT_BATCH_SIZE = 100;
const PROGRESS_ROW_INTERVAL = 25;
const MAX_TRANSIENT_RETRY_ATTEMPTS = 8;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;

function emptyCounts(): CiphertextCounts {
  return { legacy: 0, dual: 0, kms: 0 };
}

function formatCounts(counts: CiphertextCounts): string {
  return `legacy=${counts.legacy} dual=${counts.dual} kms=${counts.kms}`;
}

function logProgress(message: string): void {
  process.stdout.write(`[${nowDate().toISOString()}] ${message}\n`);
}

function shouldLogRowProgress(scanned: number): boolean {
  return scanned > 0 && scanned % PROGRESS_ROW_INTERVAL === 0;
}

function incrementCount(
  counts: CiphertextCounts,
  format: StoredSecretCiphertextFormat,
): CiphertextCounts {
  return {
    ...counts,
    [format]: counts[format] + 1,
  };
}

function countCiphertexts(
  rows: readonly { readonly encrypted: string | null }[],
): CiphertextCounts {
  return rows.reduce((counts, row) => {
    if (!row.encrypted) {
      return counts;
    }
    return incrementCount(
      counts,
      inspectPersistentSecretCiphertext(row.encrypted).format,
    );
  }, emptyCounts());
}

function parseMode(
  value: string | undefined,
): Exclude<StoredSecretWriteMode, "legacy"> {
  if (value === "dual" || value === "kms") {
    return value;
  }
  throw new Error("--mode must be dual or kms");
}

function parsePositiveInteger(value: string | undefined): number {
  if (!value) {
    throw new Error("--batch-size requires a value");
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--batch-size must be a positive integer");
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): MigrationArgs {
  let dryRun = false;
  let reportOnly = false;
  let mode: Exclude<StoredSecretWriteMode, "legacy"> = "dual";
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--report-only") {
      reportOnly = true;
    } else if (arg === "--mode") {
      index += 1;
      mode = parseMode(argv[index]);
    } else if (arg.startsWith("--mode=")) {
      mode = parseMode(arg.slice("--mode=".length));
    } else if (arg === "--batch-size") {
      index += 1;
      batchSize = parsePositiveInteger(argv[index]);
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = parsePositiveInteger(arg.slice("--batch-size=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    dryRun: dryRun || reportOnly,
    reportOnly,
    mode,
    batchSize,
  };
}

function needsMigration(
  encrypted: string | null,
  mode: Exclude<StoredSecretWriteMode, "legacy">,
): boolean {
  if (!encrypted) {
    return false;
  }

  const format = inspectPersistentSecretCiphertext(encrypted).format;
  if (mode === "dual") {
    return format === "legacy";
  }
  return format !== "kms";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function numberProperty(value: unknown, property: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[property];
  return typeof propertyValue === "number" ? propertyValue : undefined;
}

function isTransientErrorCode(code: string): boolean {
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN"
  );
}

function isTransientErrorName(name: string): boolean {
  return (
    name === "TimeoutError" ||
    name === "RequestTimeout" ||
    name === "ServiceUnavailableException" ||
    name === "Throttling" ||
    name === "ThrottlingException" ||
    name === "TooManyRequestsException"
  );
}

function isTransientOperationError(error: unknown): boolean {
  const code = stringProperty(error, "code");
  if (code && isTransientErrorCode(code)) {
    return true;
  }

  const name = stringProperty(error, "name");
  if (name && isTransientErrorName(name)) {
    return true;
  }

  const metadata = isRecord(error) ? error.$metadata : undefined;
  const statusCode = numberProperty(metadata, "httpStatusCode");
  return statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
}

function describeError(error: unknown): string {
  const name = stringProperty(error, "name");
  const code = stringProperty(error, "code");
  const message = stringProperty(error, "message");
  return [name, code, message].filter(Boolean).join(" ");
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    TRANSIENT_RETRY_MAX_DELAY_MS,
  );
}

async function withTransientRetry<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await settle(action());
    if (result.ok) {
      return result.value;
    }

    if (
      attempt >= MAX_TRANSIENT_RETRY_ATTEMPTS ||
      !isTransientOperationError(result.error)
    ) {
      throw result.error;
    }

    const delayMs = retryDelayMs(attempt);
    logProgress(
      `${operation}: transient error on attempt ${attempt}/${MAX_TRANSIENT_RETRY_ATTEMPTS}; retrying in ${delayMs}ms; ${describeError(
        result.error,
      )}`,
    );
    await delay(delayMs, { signal: new AbortController().signal });
  }
}

function parseStoredExecutionContext(value: unknown): StoredExecutionContext {
  if (isRecord(value) && isRecord(value.storageManifest)) {
    const storageManifest = value.storageManifest;
    if (!("artifacts" in storageManifest)) {
      return storedExecutionContextSchema.parse({
        ...value,
        storageManifest: {
          ...storageManifest,
          artifacts: [],
        },
      });
    }
  }

  return storedExecutionContextSchema.parse(value);
}

async function reencryptCiphertext(
  encrypted: string,
  mode: Exclude<StoredSecretWriteMode, "legacy">,
): Promise<string> {
  return await withTransientRetry(
    "persistent secret re-encryption",
    async () => {
      const plaintext = await decryptPersistentSecretValueWithMode(
        encrypted,
        "prefer-legacy",
      );
      return await encryptPersistentSecretValueWithMode(plaintext, mode);
    },
  );
}

async function reencryptExecutionContextSecrets(
  executionContext: StoredExecutionContext,
  mode: Exclude<StoredSecretWriteMode, "legacy">,
): Promise<StoredExecutionContext> {
  const encryptedSecrets = executionContext.encryptedSecrets;
  if (!encryptedSecrets || !needsMigration(encryptedSecrets, mode)) {
    return executionContext;
  }

  return {
    ...executionContext,
    encryptedSecrets: await reencryptCiphertext(encryptedSecrets, mode),
  };
}

async function migrateDirectColumn(
  targetName: string,
  args: MigrationArgs,
  selectBatch: SelectBatch,
  updateRow: UpdateEncryptedRow,
): Promise<number> {
  if (args.reportOnly) {
    return 0;
  }

  let migrated = 0;
  let scanned = 0;
  let candidates = 0;
  let batchNumber = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await selectBatch(cursor, args.batchSize);
    if (rows.length === 0) {
      return migrated;
    }
    cursor = rows[rows.length - 1]?.key;
    batchNumber += 1;

    for (const row of rows) {
      scanned += 1;
      if (shouldLogRowProgress(scanned)) {
        logProgress(
          `${targetName}: scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
        );
      }
      if (!row.encrypted || !needsMigration(row.encrypted, args.mode)) {
        continue;
      }

      candidates += 1;
      const encrypted = await reencryptCiphertext(row.encrypted, args.mode);
      if (!args.dryRun) {
        migrated += await updateRow(row, encrypted);
      } else {
        migrated += 1;
      }
    }

    logProgress(
      `${targetName}: batch=${batchNumber} rows=${rows.length} scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
    );
  }
}

async function countSlackInstallations(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: slackOrgInstallations.encryptedBotToken })
    .from(slackOrgInstallations);
  return countCiphertexts(rows);
}

async function migrateSlackInstallations(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  const database = db();
  return await migrateDirectColumn(
    targetName,
    args,
    async (cursor, batchSize) => {
      const predicates = cursor
        ? [gt(slackOrgInstallations.slackWorkspaceId, cursor)]
        : [];
      return await database
        .select({
          key: slackOrgInstallations.slackWorkspaceId,
          encrypted: slackOrgInstallations.encryptedBotToken,
        })
        .from(slackOrgInstallations)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(slackOrgInstallations.slackWorkspaceId))
        .limit(batchSize);
    },
    async (row, encrypted) => {
      const updated = await database
        .update(slackOrgInstallations)
        .set({ encryptedBotToken: encrypted })
        .where(
          and(
            eq(slackOrgInstallations.slackWorkspaceId, row.key),
            eq(slackOrgInstallations.encryptedBotToken, row.encrypted!),
          ),
        )
        .returning({ key: slackOrgInstallations.slackWorkspaceId });
      return updated.length;
    },
  );
}

async function countTelegramInstallations(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: telegramInstallations.encryptedBotToken })
    .from(telegramInstallations);
  return countCiphertexts(rows);
}

async function migrateTelegramInstallations(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  const database = db();
  return await migrateDirectColumn(
    targetName,
    args,
    async (cursor, batchSize) => {
      const predicates = cursor
        ? [gt(telegramInstallations.telegramBotId, cursor)]
        : [];
      return await database
        .select({
          key: telegramInstallations.telegramBotId,
          encrypted: telegramInstallations.encryptedBotToken,
        })
        .from(telegramInstallations)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(telegramInstallations.telegramBotId))
        .limit(batchSize);
    },
    async (row, encrypted) => {
      const updated = await database
        .update(telegramInstallations)
        .set({ encryptedBotToken: encrypted })
        .where(
          and(
            eq(telegramInstallations.telegramBotId, row.key),
            eq(telegramInstallations.encryptedBotToken, row.encrypted!),
          ),
        )
        .returning({ key: telegramInstallations.telegramBotId });
      return updated.length;
    },
  );
}

async function countGithubInstallations(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: githubInstallations.encryptedAccessToken })
    .from(githubInstallations)
    .where(isNotNull(githubInstallations.encryptedAccessToken));
  return countCiphertexts(rows);
}

async function migrateGithubInstallations(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  const database = db();
  return await migrateDirectColumn(
    targetName,
    args,
    async (cursor, batchSize) => {
      const predicates = [isNotNull(githubInstallations.encryptedAccessToken)];
      if (cursor) {
        predicates.push(gt(githubInstallations.id, cursor));
      }
      return await database
        .select({
          key: githubInstallations.id,
          encrypted: githubInstallations.encryptedAccessToken,
        })
        .from(githubInstallations)
        .where(and(...predicates))
        .orderBy(asc(githubInstallations.id))
        .limit(batchSize);
    },
    async (row, encrypted) => {
      const updated = await database
        .update(githubInstallations)
        .set({ encryptedAccessToken: encrypted })
        .where(
          and(
            eq(githubInstallations.id, row.key),
            eq(githubInstallations.encryptedAccessToken, row.encrypted!),
          ),
        )
        .returning({ key: githubInstallations.id });
      return updated.length;
    },
  );
}

async function countAgentRunCallbacks(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks);
  return countCiphertexts(rows);
}

async function migrateAgentRunCallbacks(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  const database = db();
  return await migrateDirectColumn(
    targetName,
    args,
    async (cursor, batchSize) => {
      const predicates = cursor ? [gt(agentRunCallbacks.id, cursor)] : [];
      return await database
        .select({
          key: agentRunCallbacks.id,
          encrypted: agentRunCallbacks.encryptedSecret,
        })
        .from(agentRunCallbacks)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(agentRunCallbacks.id))
        .limit(batchSize);
    },
    async (row, encrypted) => {
      const updated = await database
        .update(agentRunCallbacks)
        .set({ encryptedSecret: encrypted })
        .where(
          and(
            eq(agentRunCallbacks.id, row.key),
            eq(agentRunCallbacks.encryptedSecret, row.encrypted!),
          ),
        )
        .returning({ key: agentRunCallbacks.id });
      return updated.length;
    },
  );
}

async function countCliAuthProviderStates(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: connectorCliAuthSessions.encryptedProviderState })
    .from(connectorCliAuthSessions)
    .where(isNotNull(connectorCliAuthSessions.encryptedProviderState));
  return countCiphertexts(rows);
}

async function migrateCliAuthProviderStates(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  const database = db();
  return await migrateDirectColumn(
    targetName,
    args,
    async (cursor, batchSize) => {
      const predicates = [
        isNotNull(connectorCliAuthSessions.encryptedProviderState),
      ];
      if (cursor) {
        predicates.push(gt(connectorCliAuthSessions.id, cursor));
      }
      return await database
        .select({
          key: connectorCliAuthSessions.id,
          encrypted: connectorCliAuthSessions.encryptedProviderState,
        })
        .from(connectorCliAuthSessions)
        .where(and(...predicates))
        .orderBy(asc(connectorCliAuthSessions.id))
        .limit(batchSize);
    },
    async (row, encrypted) => {
      const updated = await database
        .update(connectorCliAuthSessions)
        .set({ encryptedProviderState: encrypted })
        .where(
          and(
            eq(connectorCliAuthSessions.id, row.key),
            eq(connectorCliAuthSessions.encryptedProviderState, row.encrypted!),
          ),
        )
        .returning({ key: connectorCliAuthSessions.id });
      return updated.length;
    },
  );
}

async function countAgentRunQueuePayloads(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: agentRunQueue.encryptedParams })
    .from(agentRunQueue)
    .where(isNotNull(agentRunQueue.encryptedParams));
  return countCiphertexts(rows);
}

async function migrateAgentRunQueuePayloads(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  if (args.reportOnly) {
    return 0;
  }

  const database = db();
  let migrated = 0;
  let scanned = 0;
  let candidates = 0;
  let batchNumber = 0;
  let cursor: string | undefined;

  for (;;) {
    const predicates = [isNotNull(agentRunQueue.encryptedParams)];
    if (cursor) {
      predicates.push(gt(agentRunQueue.runId, cursor));
    }
    const rows = await database
      .select({
        key: agentRunQueue.runId,
        encrypted: agentRunQueue.encryptedParams,
      })
      .from(agentRunQueue)
      .where(and(...predicates))
      .orderBy(asc(agentRunQueue.runId))
      .limit(args.batchSize);

    if (rows.length === 0) {
      return migrated;
    }
    cursor = rows[rows.length - 1]?.key;
    batchNumber += 1;

    for (const row of rows) {
      scanned += 1;
      if (shouldLogRowProgress(scanned)) {
        logProgress(
          `${targetName}: scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
        );
      }
      if (!row.encrypted) {
        continue;
      }

      const payload = await withTransientRetry(
        `${targetName}: decrypt queued payload`,
        async () => {
          return await decryptQueuedRunnerJobPayloadWithMode(
            row.encrypted,
            "prefer-legacy",
          );
        },
      );
      if (!payload) {
        continue;
      }

      const executionContext = await reencryptExecutionContextSecrets(
        payload.executionContext,
        args.mode,
      );
      if (
        !needsMigration(row.encrypted, args.mode) &&
        executionContext === payload.executionContext
      ) {
        continue;
      }

      candidates += 1;
      const encryptedParams = await withTransientRetry(
        `${targetName}: encrypt queued payload`,
        async () => {
          return await encryptQueuedRunnerJobPayloadWithMode(
            {
              ...payload,
              executionContext,
            },
            args.mode,
          );
        },
      );
      if (!args.dryRun) {
        const updated = await database
          .update(agentRunQueue)
          .set({ encryptedParams })
          .where(
            and(
              eq(agentRunQueue.runId, row.key),
              eq(agentRunQueue.encryptedParams, row.encrypted),
            ),
          )
          .returning({ key: agentRunQueue.runId });
        migrated += updated.length;
      } else {
        migrated += 1;
      }
    }

    logProgress(
      `${targetName}: batch=${batchNumber} rows=${rows.length} scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
    );
  }
}

async function countRunnerJobExecutionContexts(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ executionContext: runnerJobQueue.executionContext })
    .from(runnerJobQueue);
  const encryptedRows = rows.map((row) => {
    const executionContext = parseStoredExecutionContext(row.executionContext);
    return { encrypted: executionContext.encryptedSecrets };
  });
  return countCiphertexts(encryptedRows);
}

async function migrateRunnerJobExecutionContexts(
  args: MigrationArgs,
  targetName: string,
): Promise<number> {
  if (args.reportOnly) {
    return 0;
  }

  const database = db();
  let migrated = 0;
  let scanned = 0;
  let candidates = 0;
  let batchNumber = 0;
  let cursor: string | undefined;

  for (;;) {
    const predicates = cursor ? [gt(runnerJobQueue.runId, cursor)] : [];
    const rows = await database
      .select({
        key: runnerJobQueue.runId,
        executionContext: runnerJobQueue.executionContext,
      })
      .from(runnerJobQueue)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(asc(runnerJobQueue.runId))
      .limit(args.batchSize);

    if (rows.length === 0) {
      return migrated;
    }
    cursor = rows[rows.length - 1]?.key;
    batchNumber += 1;

    for (const row of rows) {
      scanned += 1;
      if (shouldLogRowProgress(scanned)) {
        logProgress(
          `${targetName}: scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
        );
      }
      const executionContext = parseStoredExecutionContext(
        row.executionContext,
      );
      const updatedContext = await reencryptExecutionContextSecrets(
        executionContext,
        args.mode,
      );
      if (updatedContext === executionContext) {
        continue;
      }

      candidates += 1;
      if (!args.dryRun) {
        const updated = await database
          .update(runnerJobQueue)
          .set({ executionContext: updatedContext })
          .where(
            and(
              eq(runnerJobQueue.runId, row.key),
              eq(runnerJobQueue.executionContext, row.executionContext),
            ),
          )
          .returning({ key: runnerJobQueue.runId });
        migrated += updated.length;
      } else {
        migrated += 1;
      }
    }

    logProgress(
      `${targetName}: batch=${batchNumber} rows=${rows.length} scanned=${scanned} candidates=${candidates} migrated=${migrated}`,
    );
  }
}

function printReport(report: MigrationReport): void {
  process.stdout.write(
    [
      report.name,
      `before legacy=${report.before.legacy} dual=${report.before.dual} kms=${report.before.kms}`,
      `migrated=${report.migrated}`,
      `after legacy=${report.after.legacy} dual=${report.after.dual} kms=${report.after.kms}`,
    ].join(" | ") + "\n",
  );
}

async function report(
  name: string,
  count: () => Promise<CiphertextCounts>,
  migrate: (args: MigrationArgs, targetName: string) => Promise<number>,
  args: MigrationArgs,
): Promise<MigrationReport> {
  logProgress(`${name}: counting before`);
  const before = await count();
  logProgress(`${name}: before ${formatCounts(before)}`);
  logProgress(`${name}: migrating`);
  const migrated = await migrate(args, name);
  logProgress(`${name}: counting after`);
  const after = await count();
  logProgress(`${name}: after ${formatCounts(after)} migrated=${migrated}`);
  return {
    name,
    before,
    migrated,
    after,
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logProgress(
    `starting persistent secret KMS backfill mode=${args.mode} dryRun=${String(
      args.dryRun,
    )} batchSize=${args.batchSize}`,
  );
  const reports: MigrationReport[] = [
    await report(
      "slack_org_installations.encrypted_bot_token",
      countSlackInstallations,
      migrateSlackInstallations,
      args,
    ),
    await report(
      "telegram_installations.encrypted_bot_token",
      countTelegramInstallations,
      migrateTelegramInstallations,
      args,
    ),
    await report(
      "github_installations.encrypted_access_token",
      countGithubInstallations,
      migrateGithubInstallations,
      args,
    ),
    await report(
      "agent_run_callbacks.encrypted_secret",
      countAgentRunCallbacks,
      migrateAgentRunCallbacks,
      args,
    ),
    await report(
      "connector_cli_auth_sessions.encrypted_provider_state",
      countCliAuthProviderStates,
      migrateCliAuthProviderStates,
      args,
    ),
    await report(
      "agent_run_queue.encrypted_params",
      countAgentRunQueuePayloads,
      migrateAgentRunQueuePayloads,
      args,
    ),
    await report(
      "runner_job_queue.execution_context.encrypted_secrets",
      countRunnerJobExecutionContexts,
      migrateRunnerJobExecutionContexts,
      args,
    ),
  ];

  process.stdout.write(
    `mode=${args.mode} dryRun=${String(args.dryRun)} batchSize=${
      args.batchSize
    }\n`,
  );
  for (const migrationReport of reports) {
    printReport(migrationReport);
  }
}

const result = await settle(run());
await closeDbPool();
if (!result.ok) {
  throw result.error;
}
