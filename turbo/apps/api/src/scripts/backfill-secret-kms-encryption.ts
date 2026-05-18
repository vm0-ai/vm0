#!/usr/bin/env tsx

import { and, eq, isNotNull, like, not } from "drizzle-orm";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { secrets } from "@vm0/db/schema/secret";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";

import { closeDbPool, db } from "../lib/db";
import {
  decryptStoredSecretValueWithMode,
  encryptStoredSecretValueWithMode,
  inspectStoredSecretCiphertext,
  STORED_SECRET_ENVELOPE_PREFIX,
  type StoredSecretCiphertextFormat,
  type StoredSecretWriteMode,
} from "../signals/services/crypto.utils";
import { settle } from "../signals/utils";

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

type EncryptedRow = {
  readonly encrypted: string | null;
};

const DEFAULT_BATCH_SIZE = 100;

function emptyCounts(): CiphertextCounts {
  return { legacy: 0, dual: 0, kms: 0 };
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

function countCiphertexts(rows: readonly EncryptedRow[]): CiphertextCounts {
  return rows.reduce((counts, row) => {
    if (!row.encrypted) {
      return counts;
    }
    return incrementCount(
      counts,
      inspectStoredSecretCiphertext(row.encrypted).format,
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

async function reencryptCiphertext(
  encrypted: string,
  mode: Exclude<StoredSecretWriteMode, "legacy">,
): Promise<string> {
  const plaintext = await decryptStoredSecretValueWithMode(
    encrypted,
    "prefer-legacy",
  );
  return encryptStoredSecretValueWithMode(plaintext, mode);
}

async function migrateSecretsTable(args: MigrationArgs): Promise<number> {
  let migrated = 0;
  const database = db();

  while (!args.reportOnly) {
    const rows = await database
      .select({ id: secrets.id, encrypted: secrets.encryptedValue })
      .from(secrets)
      .where(
        not(like(secrets.encryptedValue, `${STORED_SECRET_ENVELOPE_PREFIX}%`)),
      )
      .limit(args.batchSize);

    if (rows.length === 0) {
      return migrated;
    }

    for (const row of rows) {
      const encryptedValue = await reencryptCiphertext(
        row.encrypted,
        args.mode,
      );
      if (!args.dryRun) {
        const updatedRows = await database
          .update(secrets)
          .set({ encryptedValue })
          .where(
            and(
              eq(secrets.id, row.id),
              eq(secrets.encryptedValue, row.encrypted),
            ),
          )
          .returning({ id: secrets.id });
        migrated += updatedRows.length;
      } else {
        migrated += 1;
      }
    }

    if (args.dryRun) {
      return migrated;
    }
  }

  return migrated;
}

async function migrateOrgCustomConnectorSecretsTable(
  args: MigrationArgs,
): Promise<number> {
  let migrated = 0;
  const database = db();

  while (!args.reportOnly) {
    const rows = await database
      .select({
        id: orgCustomConnectorSecrets.id,
        encrypted: orgCustomConnectorSecrets.encryptedValue,
      })
      .from(orgCustomConnectorSecrets)
      .where(
        not(
          like(
            orgCustomConnectorSecrets.encryptedValue,
            `${STORED_SECRET_ENVELOPE_PREFIX}%`,
          ),
        ),
      )
      .limit(args.batchSize);

    if (rows.length === 0) {
      return migrated;
    }

    for (const row of rows) {
      const encryptedValue = await reencryptCiphertext(
        row.encrypted,
        args.mode,
      );
      if (!args.dryRun) {
        const updatedRows = await database
          .update(orgCustomConnectorSecrets)
          .set({ encryptedValue })
          .where(
            and(
              eq(orgCustomConnectorSecrets.id, row.id),
              eq(orgCustomConnectorSecrets.encryptedValue, row.encrypted),
            ),
          )
          .returning({ id: orgCustomConnectorSecrets.id });
        migrated += updatedRows.length;
      } else {
        migrated += 1;
      }
    }

    if (args.dryRun) {
      return migrated;
    }
  }

  return migrated;
}

async function migrateZeroAgentSchedulesTable(
  args: MigrationArgs,
): Promise<number> {
  let migrated = 0;
  const database = db();

  while (!args.reportOnly) {
    const rows = await database
      .select({
        id: zeroAgentSchedules.id,
        encrypted: zeroAgentSchedules.encryptedSecrets,
      })
      .from(zeroAgentSchedules)
      .where(
        and(
          isNotNull(zeroAgentSchedules.encryptedSecrets),
          not(
            like(
              zeroAgentSchedules.encryptedSecrets,
              `${STORED_SECRET_ENVELOPE_PREFIX}%`,
            ),
          ),
        ),
      )
      .limit(args.batchSize);

    if (rows.length === 0) {
      return migrated;
    }

    for (const row of rows) {
      if (!row.encrypted) {
        continue;
      }
      const encryptedSecrets = await reencryptCiphertext(
        row.encrypted,
        args.mode,
      );
      if (!args.dryRun) {
        const updatedRows = await database
          .update(zeroAgentSchedules)
          .set({ encryptedSecrets })
          .where(
            and(
              eq(zeroAgentSchedules.id, row.id),
              eq(zeroAgentSchedules.encryptedSecrets, row.encrypted),
            ),
          )
          .returning({ id: zeroAgentSchedules.id });
        migrated += updatedRows.length;
      } else {
        migrated += 1;
      }
    }

    if (args.dryRun) {
      return migrated;
    }
  }

  return migrated;
}

async function countSecretsTable(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: secrets.encryptedValue })
    .from(secrets);
  return countCiphertexts(rows);
}

async function countOrgCustomConnectorSecretsTable(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: orgCustomConnectorSecrets.encryptedValue })
    .from(orgCustomConnectorSecrets);
  return countCiphertexts(rows);
}

async function countZeroAgentSchedulesTable(): Promise<CiphertextCounts> {
  const rows = await db()
    .select({ encrypted: zeroAgentSchedules.encryptedSecrets })
    .from(zeroAgentSchedules)
    .where(isNotNull(zeroAgentSchedules.encryptedSecrets));
  return countCiphertexts(rows);
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

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const reports: MigrationReport[] = [
    {
      name: "secrets.encrypted_value",
      before: await countSecretsTable(),
      migrated: await migrateSecretsTable(args),
      after: await countSecretsTable(),
    },
    {
      name: "org_custom_connector_secrets.encrypted_value",
      before: await countOrgCustomConnectorSecretsTable(),
      migrated: await migrateOrgCustomConnectorSecretsTable(args),
      after: await countOrgCustomConnectorSecretsTable(),
    },
    {
      name: "zero_agent_schedules.encrypted_secrets",
      before: await countZeroAgentSchedulesTable(),
      migrated: await migrateZeroAgentSchedulesTable(args),
      after: await countZeroAgentSchedulesTable(),
    },
  ];

  process.stdout.write(
    `mode=${args.mode} dryRun=${String(args.dryRun)} batchSize=${
      args.batchSize
    }\n`,
  );
  for (const report of reports) {
    printReport(report);
  }
}

const result = await settle(run());
await closeDbPool();
if (!result.ok) {
  throw result.error;
}
