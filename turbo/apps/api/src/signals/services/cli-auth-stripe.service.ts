import { command, type Setter } from "ccstate";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { getVercelSandboxClient } from "../external/vercel-sandbox";
import {
  sandboxOperation,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxHandle,
} from "../external/sandbox";
import { connectors } from "@vm0/db/schema/connector";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { safeJsonParse, safeSync, settle } from "../utils";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  decryptPersistentSecretValue,
  decryptSecretValue,
  encryptPersistentSecretValue,
  encryptSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchContext,
} from "./feature-switches.service";
import {
  parseStripeCliAuthConfig,
  parseStripeCliAuthStartOutput as parseStripeCliAuthStartOutputText,
  redactStripeCliAuthText,
  type StripeCliAuthMode,
  type StripeCliAuthStartOutput,
} from "./cli-auth-stripe-parser";

const CLI_AUTH_STRIPE_RUNTIME = "node24";
const CLI_AUTH_STRIPE_VERSION = "1.40.9";
const CLI_AUTH_STRIPE_ARCHIVE = `stripe_${CLI_AUTH_STRIPE_VERSION}_linux_x86_64.tar.gz`;
const CLI_AUTH_STRIPE_RELEASE_URL = `https://github.com/stripe/stripe-cli/releases/download/v${CLI_AUTH_STRIPE_VERSION}`;
const CLI_AUTH_STRIPE_TIMEOUT_MS = 15 * 60 * 1000;
const CLI_AUTH_STRIPE_SESSION_TTL_SECONDS = 10 * 60;
const CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS = 5;
const CLI_AUTH_STRIPE_COMPLETE_TIMEOUT_SECONDS = 15;
const CLI_AUTH_STRIPE_INITIALIZING_STALE_MS = 2 * 60 * 1000;
const CLI_AUTH_STRIPE_COMPLETING_STALE_MS = 2 * 60 * 1000;
const CLI_AUTH_STRIPE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const CLI_AUTH_STRIPE_CONFIG_LIMIT_BYTES = 16 * 1024;
const CLI_AUTH_STRIPE_ROOT = "/vercel/sandbox/cli-auth/stripe";
const CLI_AUTH_STRIPE_BIN_DIR = `${CLI_AUTH_STRIPE_ROOT}/bin`;
const CLI_AUTH_STRIPE_CONFIG_HOME = `${CLI_AUTH_STRIPE_ROOT}/config`;
const CLI_AUTH_STRIPE_CONFIG_PATH = `${CLI_AUTH_STRIPE_CONFIG_HOME}/stripe/config.toml`;
const CLI_AUTH_STRIPE_CONNECTOR_TYPE = "stripe";
const CLI_AUTH_STRIPE_SOURCE = "stripe-cli";
const STRIPE_TOKEN_SECRET_NAME = "STRIPE_TOKEN";
const STRIPE_OAUTH_SECRET_NAMES = [
  "STRIPE_ACCESS_TOKEN",
  "STRIPE_REFRESH_TOKEN",
] as const;
const L = logger("CliAuthStripe");

const cliAuthStripeSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const cliAuthStripeProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("stripe"),
  mode: z.enum(["test", "live"]),
  pollUrl: z.url(),
});

type CliAuthStripeSessionToken = z.infer<
  typeof cliAuthStripeSessionTokenSchema
>;
type CliAuthStripeProviderState = z.infer<
  typeof cliAuthStripeProviderStateSchema
>;

type CliAuthStripeFailureCode =
  | "CLI_AUTH_STRIPE_UNAVAILABLE"
  | "CLI_AUTH_STRIPE_FAILED"
  | "CLI_AUTH_STRIPE_TOKEN_INVALID"
  | "CLI_AUTH_STRIPE_TOKEN_EXPIRED";

type CliAuthStripeStartResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly browserUrl: string;
      readonly verificationCode: string;
      readonly mode: StripeCliAuthMode;
      readonly expiresIn: number;
      readonly interval: number;
    }
  | {
      readonly ok: false;
      readonly code: CliAuthStripeFailureCode;
      readonly message: string;
    };

type CliAuthStripeCompleteResult =
  | {
      readonly status: "pending";
      readonly errorMessage: string | null;
    }
  | {
      readonly status: "complete";
      readonly connector: ConnectorResponse;
    }
  | {
      readonly status: "invalid_token";
      readonly code: CliAuthStripeFailureCode;
      readonly message: string;
    }
  | {
      readonly status: "forbidden";
      readonly code: CliAuthStripeFailureCode;
      readonly message: string;
    }
  | {
      readonly status: "error";
      readonly code: CliAuthStripeFailureCode;
      readonly message: string;
    };

type CliAuthStripeStartFailureResult = Extract<
  CliAuthStripeStartResult,
  { readonly ok: false }
>;
type CliAuthStripeErrorResult = Extract<
  CliAuthStripeCompleteResult,
  { readonly status: "error" }
>;
type CliAuthStripePendingResult = Extract<
  CliAuthStripeCompleteResult,
  { readonly status: "pending" }
>;
type ConnectorCliAuthSession = typeof connectorCliAuthSessions.$inferSelect;
type ConnectorCliAuthSessionStatus = ConnectorCliAuthSession["status"];

const CLI_AUTH_STRIPE_ACTIVE_STATUSES = [
  "initializing",
  "awaiting_user_approval",
  "completing",
] as const satisfies readonly ConnectorCliAuthSessionStatus[];

const CLI_AUTH_STRIPE_SUPERSEDED_MESSAGE =
  "CLI auth for Stripe session was superseded";
const CLI_AUTH_STRIPE_CREDENTIALS_CHANGED_MESSAGE =
  "CLI auth for Stripe session was cancelled because Stripe credentials changed";

type PreparedCliAuthStripeCompletion =
  | {
      readonly ok: true;
      readonly session: ConnectorCliAuthSession;
      readonly providerState: CliAuthStripeProviderState;
      readonly sandbox: SandboxHandle;
    }
  | {
      readonly ok: false;
      readonly result: CliAuthStripeCompleteResult;
    };

type PreparedCliAuthStripeStart =
  | {
      readonly kind: "created";
      readonly session: ConnectorCliAuthSession;
      readonly cleanupSandboxes: readonly SandboxHandle[];
    }
  | {
      readonly kind: "reuse";
      readonly result: Extract<CliAuthStripeStartResult, { readonly ok: true }>;
      readonly cleanupSandboxes: readonly SandboxHandle[];
    }
  | {
      readonly kind: "busy";
      readonly result: CliAuthStripeStartFailureResult;
      readonly cleanupSandboxes: readonly SandboxHandle[];
    };

function startCommandScript(): string {
  return String.raw`set -euo pipefail
BIN_DIR="${CLI_AUTH_STRIPE_BIN_DIR}"
CONFIG_HOME="${CLI_AUTH_STRIPE_CONFIG_HOME}"
mkdir -p "$BIN_DIR" "$CONFIG_HOME"
if [ ! -x "$BIN_DIR/stripe" ]; then
  curl -fsSL "${CLI_AUTH_STRIPE_RELEASE_URL}/${CLI_AUTH_STRIPE_ARCHIVE}" -o "/tmp/${CLI_AUTH_STRIPE_ARCHIVE}"
  curl -fsSL "${CLI_AUTH_STRIPE_RELEASE_URL}/stripe-linux-checksums.txt" -o /tmp/stripe-linux-checksums.txt
  grep " ${CLI_AUTH_STRIPE_ARCHIVE}$" /tmp/stripe-linux-checksums.txt > /tmp/stripe-cli.sha256
  (cd /tmp && sha256sum -c stripe-cli.sha256) >&2
  tar -xzf "/tmp/${CLI_AUTH_STRIPE_ARCHIVE}" -C "$BIN_DIR" stripe
  chmod +x "$BIN_DIR/stripe"
fi
export PATH="$BIN_DIR:$PATH"
export XDG_CONFIG_HOME="$CONFIG_HOME"
export STRIPE_DEVICE_NAME="\${STRIPE_DEVICE_NAME:-vm0-cli-auth}"
stripe login --non-interactive`;
}

function completeCommandScript(): string {
  return String.raw`set -euo pipefail
BIN_DIR="${CLI_AUTH_STRIPE_BIN_DIR}"
CONFIG_HOME="${CLI_AUTH_STRIPE_CONFIG_HOME}"
test -x "$BIN_DIR/stripe"
export PATH="$BIN_DIR:$PATH"
export XDG_CONFIG_HOME="$CONFIG_HOME"
timeout ${CLI_AUTH_STRIPE_COMPLETE_TIMEOUT_SECONDS}s stripe login --complete "$STRIPE_POLL_URL"`;
}

function tokenExpiresAt(now: Date): Date {
  return new Date(now.getTime() + CLI_AUTH_STRIPE_SESSION_TTL_SECONDS * 1000);
}

function encodeSession(payload: CliAuthStripeSessionToken): string {
  return encryptSecretValue(JSON.stringify(payload));
}

async function encodeProviderState(
  payload: CliAuthStripeProviderState,
  featureSwitchContext: FeatureSwitchContext,
): Promise<string> {
  return await encryptPersistentSecretValue(
    JSON.stringify(payload),
    featureSwitchContext,
  );
}

function decodeSession(token: string): CliAuthStripeSessionToken | null {
  const decoded = safeSync(() => {
    const parsed = cliAuthStripeSessionTokenSchema.safeParse(
      safeJsonParse(decryptSecretValue(token)),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

async function decodeProviderState(
  encryptedProviderState: string | null,
  featureSwitchContext: FeatureSwitchContext,
): Promise<CliAuthStripeProviderState | null> {
  if (!encryptedProviderState) {
    return null;
  }
  const decrypted = await settle(
    decryptPersistentSecretValue(encryptedProviderState, featureSwitchContext),
  );
  if (!decrypted.ok) {
    return null;
  }
  const parsed = cliAuthStripeProviderStateSchema.safeParse(
    safeJsonParse(decrypted.value),
  );
  return parsed.success ? parsed.data : null;
}

function commandText(result: SandboxCommandResult): string {
  return [result.stdout.text, result.stderr.text].filter(Boolean).join("\n");
}

function commandFailedMessage(
  phase: string,
  result: SandboxCommandResult,
): string {
  const output = redactStripeCliAuthText(commandText(result).trim());
  const suffix = output ? `: ${output.slice(0, 500)}` : "";
  return `${phase} exited with code ${String(result.exitCode)}${suffix}`;
}

function isPendingCompletion(result: SandboxCommandResult): boolean {
  if (result.exitCode === 124) {
    return true;
  }
  return /exceeded max attempts/i.test(commandText(result));
}

function stopSandbox(client: SandboxClient, sandbox: SandboxHandle) {
  return client.stop(sandbox);
}

async function cleanupSandbox(client: SandboxClient, sandbox: SandboxHandle) {
  const cleanup = await stopSandbox(client, sandbox);
  if (cleanup.status === "failed") {
    return cleanup.error.message;
  }
  return null;
}

async function cleanupSandboxSafely(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly reason: string;
}) {
  const cleanupResult = await sandboxOperation("stop", () => {
    return cleanupSandbox(args.client, args.sandbox);
  });
  if (!cleanupResult.ok) {
    L.warn("Failed to clean up CLI auth Stripe sandbox", {
      sandboxId: args.sandbox.sandboxId,
      reason: args.reason,
      error: cleanupResult.error,
    });
    return;
  }
  if (cleanupResult.value) {
    L.warn("CLI auth Stripe sandbox cleanup reported failure", {
      sandboxId: args.sandbox.sandboxId,
      reason: args.reason,
      message: cleanupResult.value,
    });
  }
}

function sanitizeSessionError(message: string): string {
  return redactStripeCliAuthText(message).slice(0, 500);
}

function remainingSessionTtlSeconds(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
}

function sandboxHandlesFromIds(
  sandboxIds: readonly (string | null)[],
): readonly SandboxHandle[] {
  return sandboxIds.flatMap((sandboxId) => {
    return sandboxId ? [{ sandboxId }] : [];
  });
}

async function cleanupCliAuthStripeSandboxes(args: {
  readonly client: SandboxClient;
  readonly sandboxes: readonly SandboxHandle[];
  readonly reason: string;
}) {
  for (const sandbox of args.sandboxes) {
    await cleanupSandboxSafely({
      client: args.client,
      sandbox,
      reason: args.reason,
    });
  }
}

/**
 * Serialize lifecycle mutations for one user's Stripe CLI auth flow.
 *
 * This follows the existing transaction-scoped advisory lock pattern used by
 * queue, credit, and Stripe customer writes. The connector type/source suffix
 * keeps the lock scope ready for future CLI auth providers.
 */
async function lockCliAuthStripeOwner(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}) {
  await args.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('cli_auth_stripe:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${CLI_AUTH_STRIPE_CONNECTOR_TYPE} || ':' || ${CLI_AUTH_STRIPE_SOURCE}))`,
  );
}

function cliAuthStripeOwnerWhere(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(connectorCliAuthSessions.orgId, args.orgId),
    eq(connectorCliAuthSessions.userId, args.userId),
    eq(connectorCliAuthSessions.connectorType, CLI_AUTH_STRIPE_CONNECTOR_TYPE),
    eq(connectorCliAuthSessions.source, CLI_AUTH_STRIPE_SOURCE),
  );
}

function activeCliAuthStripeOwnerWhere(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    cliAuthStripeOwnerWhere(args),
    inArray(connectorCliAuthSessions.status, [
      ...CLI_AUTH_STRIPE_ACTIVE_STATUSES,
    ]),
  );
}

function terminalCliAuthStripeSessionSet(args: {
  readonly status: Extract<
    ConnectorCliAuthSessionStatus,
    "cancelled" | "error" | "expired" | "imported"
  >;
  readonly now: Date;
  readonly message?: string | null;
}) {
  return {
    status: args.status,
    approvalUrl: null,
    verificationCode: null,
    encryptedProviderState: null,
    errorMessage: args.message ? sanitizeSessionError(args.message) : null,
    completedAt: args.status === "imported" ? args.now : null,
    cancelledAt: args.status === "cancelled" ? args.now : null,
    updatedAt: args.now,
  };
}

async function terminalizeCliAuthStripeSessions(args: {
  readonly db: Db;
  readonly sessionIds: readonly string[];
  readonly status: Extract<
    ConnectorCliAuthSessionStatus,
    "cancelled" | "error" | "expired"
  >;
  readonly message?: string | null;
  readonly now: Date;
}): Promise<readonly SandboxHandle[]> {
  if (args.sessionIds.length === 0) {
    return [];
  }
  const rows = await args.db
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: args.status,
        now: args.now,
        message: args.message,
      }),
    )
    .where(
      and(
        inArray(connectorCliAuthSessions.id, [...args.sessionIds]),
        inArray(connectorCliAuthSessions.status, [
          ...CLI_AUTH_STRIPE_ACTIVE_STATUSES,
        ]),
      ),
    )
    .returning({ sandboxId: connectorCliAuthSessions.sandboxId });
  return sandboxHandlesFromIds(
    rows.map((row) => {
      return row.sandboxId;
    }),
  );
}

async function cancelActiveCliAuthStripeSessions(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly now: Date;
  readonly message: string;
}): Promise<readonly SandboxHandle[]> {
  const rows = await args.db
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: "cancelled",
        now: args.now,
        message: args.message,
      }),
    )
    .where(
      activeCliAuthStripeOwnerWhere({
        orgId: args.orgId,
        userId: args.userId,
      }),
    )
    .returning({ sandboxId: connectorCliAuthSessions.sandboxId });
  return sandboxHandlesFromIds(
    rows.map((row) => {
      return row.sandboxId;
    }),
  );
}

export async function invalidateActiveCliAuthStripeSessions(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly message?: string;
}) {
  const client = getVercelSandboxClient();
  const now = nowDate();
  const sandboxes = await args.writeDb.transaction(async (tx) => {
    await lockCliAuthStripeOwner({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
    });
    return cancelActiveCliAuthStripeSessions({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      now,
      message: args.message ?? CLI_AUTH_STRIPE_CREDENTIALS_CHANGED_MESSAGE,
    });
  });
  await cleanupCliAuthStripeSandboxes({
    client,
    sandboxes,
    reason: "stripe credentials changed",
  });
  args.signal.throwIfAborted();
}

async function markCliAuthStripeSessionError(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly message: string;
  readonly expectedStatus?: ConnectorCliAuthSessionStatus;
  readonly expectedUpdatedAt?: Date;
}) {
  const predicates = [eq(connectorCliAuthSessions.id, args.sessionId)];
  if (args.expectedStatus) {
    predicates.push(eq(connectorCliAuthSessions.status, args.expectedStatus));
  }
  if (args.expectedUpdatedAt) {
    predicates.push(
      eq(connectorCliAuthSessions.updatedAt, args.expectedUpdatedAt),
    );
  }
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: "error",
        now: nowDate(),
        message: args.message,
      }),
    )
    .where(and(...predicates))
    .returning({ id: connectorCliAuthSessions.id });
  return Boolean(updated);
}

async function markCliAuthStripeSessionExpired(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
}) {
  const [expired] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: "expired",
        now: nowDate(),
      }),
    )
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.session.id),
        eq(connectorCliAuthSessions.status, args.session.status),
      ),
    )
    .returning({ id: connectorCliAuthSessions.id });
  return Boolean(expired);
}

async function createCliAuthStripeSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly expiresAt: Date;
}) {
  const [session] = await args.writeDb
    .insert(connectorCliAuthSessions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorType: CLI_AUTH_STRIPE_CONNECTOR_TYPE,
      source: CLI_AUTH_STRIPE_SOURCE,
      status: "initializing",
      expiresAt: args.expiresAt,
    })
    .returning();
  if (!session) {
    throw new Error("Failed to create CLI auth for Stripe session");
  }
  return session;
}

async function createCliAuthStripeSandbox(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly ok: true;
      readonly sandbox: SandboxHandle;
      readonly session: ConnectorCliAuthSession;
    }
  | { readonly ok: false; readonly result: CliAuthStripeStartFailureResult }
> {
  const createResult = await sandboxOperation("create", () => {
    return args.client.create({
      runtime: CLI_AUTH_STRIPE_RUNTIME,
      timeoutMs: CLI_AUTH_STRIPE_TIMEOUT_MS,
      signal: args.signal,
    });
  });

  if (!createResult.ok) {
    await markCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message: createResult.error.message,
      expectedStatus: args.session.status,
    });
    args.signal.throwIfAborted();
    return {
      ok: false,
      result: {
        ok: false,
        code: "CLI_AUTH_STRIPE_UNAVAILABLE",
        message: createResult.error.message,
      },
    };
  }

  const sandbox = createResult.value;
  const updateResult = await settle(
    args.writeDb
      .update(connectorCliAuthSessions)
      .set({
        sandboxId: sandbox.sandboxId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(connectorCliAuthSessions.id, args.session.id),
          eq(connectorCliAuthSessions.status, "initializing"),
        ),
      )
      .returning(),
  );
  if (!updateResult.ok) {
    await cleanupSandbox(args.client, sandbox);
    throw updateResult.error;
  }
  const updatedSession = updateResult.value[0];
  if (!updatedSession) {
    await cleanupSandboxSafely({
      client: args.client,
      sandbox,
      reason: "start session sandbox claim lost",
    });
    args.signal.throwIfAborted();
    return {
      ok: false,
      result: {
        ok: false,
        code: "CLI_AUTH_STRIPE_UNAVAILABLE",
        message: CLI_AUTH_STRIPE_SUPERSEDED_MESSAGE,
      },
    };
  }
  args.signal.throwIfAborted();

  return { ok: true, sandbox, session: updatedSession };
}

function parseCliAuthStripeStartOutput(
  result: SandboxCommandResult,
):
  | { readonly ok: true; readonly output: StripeCliAuthStartOutput }
  | { readonly ok: false; readonly message: string } {
  const parsedResult = safeSync(() => {
    return parseStripeCliAuthStartOutputText(result.stdout.text);
  });
  if ("error" in parsedResult) {
    const message =
      parsedResult.error instanceof Error
        ? parsedResult.error.message
        : String(parsedResult.error);
    return {
      ok: false,
      message: redactStripeCliAuthText(message),
    };
  }
  return { ok: true, output: parsedResult.ok };
}

async function runCliAuthStripeStartInSandbox(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly session: ConnectorCliAuthSession;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly output: StripeCliAuthStartOutput }
  | { readonly ok: false; readonly result: CliAuthStripeStartFailureResult }
> {
  const runResult = await sandboxOperation("run", () => {
    return args.client.runCommand(args.sandbox, {
      cmd: "sh",
      args: ["-lc", startCommandScript()],
      outputLimitBytes: CLI_AUTH_STRIPE_OUTPUT_LIMIT_BYTES,
      signal: args.signal,
    });
  });

  if (!runResult.ok) {
    await markCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message: runResult.error.message,
      expectedStatus: args.session.status,
      expectedUpdatedAt: args.session.updatedAt,
    });
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      result: {
        ok: false,
        code: "CLI_AUTH_STRIPE_FAILED",
        message: runResult.error.message,
      },
    };
  }

  if (runResult.value.exitCode !== 0) {
    const message = commandFailedMessage(
      "CLI auth for Stripe start",
      runResult.value,
    );
    await markCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message,
      expectedStatus: args.session.status,
      expectedUpdatedAt: args.session.updatedAt,
    });
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      result: {
        ok: false,
        code: "CLI_AUTH_STRIPE_FAILED",
        message,
      },
    };
  }

  const parsedResult = await parseCliAuthStripeStartOutput(runResult.value);
  if (!parsedResult.ok) {
    await markCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message: parsedResult.message,
      expectedStatus: args.session.status,
      expectedUpdatedAt: args.session.updatedAt,
    });
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      result: {
        ok: false,
        code: "CLI_AUTH_STRIPE_FAILED",
        message: parsedResult.message,
      },
    };
  }

  return { ok: true, output: parsedResult.output };
}

async function markCliAuthStripeSessionAwaitingApproval(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly output: StripeCliAuthStartOutput;
  readonly mode: StripeCliAuthMode;
  readonly featureSwitchContext: FeatureSwitchContext;
}) {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "awaiting_user_approval",
      approvalUrl: args.output.browserUrl,
      verificationCode: args.output.verificationCode,
      encryptedProviderState: await encodeProviderState(
        {
          version: 1,
          type: "stripe",
          mode: args.mode,
          pollUrl: args.output.pollUrl,
        },
        args.featureSwitchContext,
      ),
      errorMessage: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.session.id),
        eq(connectorCliAuthSessions.status, "initializing"),
        eq(connectorCliAuthSessions.updatedAt, args.session.updatedAt),
      ),
    )
    .returning({ id: connectorCliAuthSessions.id });
  return Boolean(updated);
}

function isFreshInitializingCliAuthStripeSession(
  session: ConnectorCliAuthSession,
  now: Date,
): boolean {
  return (
    session.status === "initializing" &&
    now.getTime() - session.updatedAt.getTime() <=
      CLI_AUTH_STRIPE_INITIALIZING_STALE_MS &&
    now <= session.expiresAt
  );
}

function isFreshCompletingCliAuthStripeSession(
  session: ConnectorCliAuthSession,
  now: Date,
): boolean {
  return (
    session.status === "completing" &&
    !isStaleCompletingCliAuthStripeSession(session, now) &&
    now <= session.expiresAt
  );
}

async function reusableCliAuthStripeStartResult(args: {
  readonly session: ConnectorCliAuthSession;
  readonly mode: StripeCliAuthMode;
  readonly now: Date;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Extract<CliAuthStripeStartResult, { readonly ok: true }> | null> {
  if (
    args.session.status !== "awaiting_user_approval" ||
    args.now > args.session.expiresAt ||
    !args.session.sandboxId ||
    !args.session.approvalUrl ||
    !args.session.verificationCode
  ) {
    return null;
  }
  const providerState = await decodeProviderState(
    args.session.encryptedProviderState,
    args.featureSwitchContext,
  );
  if (!providerState || providerState.mode !== args.mode) {
    return null;
  }
  return {
    ok: true,
    sessionToken: encodeSession({
      version: 1,
      sessionId: args.session.id,
    }),
    browserUrl: args.session.approvalUrl,
    verificationCode: args.session.verificationCode,
    mode: providerState.mode,
    expiresIn: remainingSessionTtlSeconds(args.session.expiresAt, args.now),
    interval: CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS,
  };
}

function prepareCliAuthStripeStartSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly mode: StripeCliAuthMode;
  readonly now: Date;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<PreparedCliAuthStripeStart> {
  return args.writeDb.transaction(async (tx) => {
    await lockCliAuthStripeOwner({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
    });

    const activeSessions = await tx
      .select()
      .from(connectorCliAuthSessions)
      .where(
        activeCliAuthStripeOwnerWhere({
          orgId: args.orgId,
          userId: args.userId,
        }),
      )
      .orderBy(connectorCliAuthSessions.createdAt);

    const expiredSessionIds: string[] = [];
    const cancelSessionIds: string[] = [];
    let reusableResult: Extract<
      CliAuthStripeStartResult,
      { readonly ok: true }
    > | null = null;
    let hasFreshInProgressSession = false;

    for (const session of activeSessions) {
      if (args.now > session.expiresAt) {
        expiredSessionIds.push(session.id);
        continue;
      }

      const reusable = await reusableCliAuthStripeStartResult({
        session,
        mode: args.mode,
        now: args.now,
        featureSwitchContext: args.featureSwitchContext,
      });
      if (reusable && !reusableResult) {
        reusableResult = reusable;
        continue;
      }

      if (
        isFreshInitializingCliAuthStripeSession(session, args.now) ||
        isFreshCompletingCliAuthStripeSession(session, args.now)
      ) {
        hasFreshInProgressSession = true;
        continue;
      }

      cancelSessionIds.push(session.id);
    }

    const expiredSandboxes = await terminalizeCliAuthStripeSessions({
      db: tx,
      sessionIds: expiredSessionIds,
      status: "expired",
      now: args.now,
    });
    const cancelledSandboxes = await terminalizeCliAuthStripeSessions({
      db: tx,
      sessionIds: cancelSessionIds,
      status: "cancelled",
      message: CLI_AUTH_STRIPE_SUPERSEDED_MESSAGE,
      now: args.now,
    });
    const cleanupSandboxes = [...expiredSandboxes, ...cancelledSandboxes];

    if (hasFreshInProgressSession) {
      return {
        kind: "busy",
        cleanupSandboxes,
        result: {
          ok: false,
          code: "CLI_AUTH_STRIPE_UNAVAILABLE",
          message: "CLI auth for Stripe session is already starting",
        },
      };
    }

    if (reusableResult) {
      return { kind: "reuse", cleanupSandboxes, result: reusableResult };
    }

    const session = await createCliAuthStripeSession({
      writeDb: tx,
      orgId: args.orgId,
      userId: args.userId,
      expiresAt: tokenExpiresAt(args.now),
    });
    return { kind: "created", cleanupSandboxes, session };
  });
}

export async function startCliAuthStripe(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly mode: StripeCliAuthMode;
  readonly signal: AbortSignal;
  readonly now?: Date;
}): Promise<CliAuthStripeStartResult> {
  const now = args.now ?? nowDate();
  const client = getVercelSandboxClient();
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    args.writeDb,
    args.orgId,
    args.userId,
  );
  const prepared = await prepareCliAuthStripeStartSession({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    mode: args.mode,
    now,
    featureSwitchContext,
  });
  await cleanupCliAuthStripeSandboxes({
    client,
    sandboxes: prepared.cleanupSandboxes,
    reason: "start session superseded active session",
  });
  args.signal.throwIfAborted();

  if (prepared.kind === "reuse" || prepared.kind === "busy") {
    return prepared.result;
  }

  const sandboxResult = await createCliAuthStripeSandbox({
    writeDb: args.writeDb,
    client,
    session: prepared.session,
    signal: args.signal,
  });
  if (!sandboxResult.ok) {
    return sandboxResult.result;
  }

  const startResult = await runCliAuthStripeStartInSandbox({
    writeDb: args.writeDb,
    client,
    sandbox: sandboxResult.sandbox,
    session: sandboxResult.session,
    signal: args.signal,
  });
  if (!startResult.ok) {
    return startResult.result;
  }
  const persistResult = await settle(
    markCliAuthStripeSessionAwaitingApproval({
      writeDb: args.writeDb,
      session: sandboxResult.session,
      output: startResult.output,
      mode: args.mode,
      featureSwitchContext,
    }),
  );
  if (!persistResult.ok) {
    await cleanupSandboxSafely({
      client,
      sandbox: sandboxResult.sandbox,
      reason: "start session persist failed",
    });
    throw persistResult.error;
  }
  if (!persistResult.value) {
    await cleanupSandboxSafely({
      client,
      sandbox: sandboxResult.sandbox,
      reason: "start session persist claim lost",
    });
    return {
      ok: false,
      code: "CLI_AUTH_STRIPE_UNAVAILABLE",
      message: CLI_AUTH_STRIPE_SUPERSEDED_MESSAGE,
    };
  }
  args.signal.throwIfAborted();

  return {
    ok: true,
    sessionToken: encodeSession({
      version: 1,
      sessionId: prepared.session.id,
    }),
    browserUrl: startResult.output.browserUrl,
    verificationCode: startResult.output.verificationCode,
    mode: args.mode,
    expiresIn: CLI_AUTH_STRIPE_SESSION_TTL_SECONDS,
    interval: CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS,
  };
}

function cliAuthStripeApiTokenConnector(): ConnectorResponse {
  return {
    id: null,
    type: "stripe",
    authMethod: "api-token",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

async function publishCliAuthStripeConnectorChanged(userId: string) {
  const publishResult = await settle(
    publishUserSignal([userId], "connector:changed"),
  );
  if (!publishResult.ok) {
    L.warn("Failed to publish CLI auth Stripe connector change", {
      userId,
      error: publishResult.error,
    });
  }
}

function claimedCliAuthStripeSessionWhere(args: {
  readonly sessionId: string;
  readonly claimedAt: Date;
}) {
  return and(
    eq(connectorCliAuthSessions.id, args.sessionId),
    eq(connectorCliAuthSessions.status, "completing"),
    eq(connectorCliAuthSessions.updatedAt, args.claimedAt),
  );
}

class CliAuthStripeClaimLostError extends Error {
  constructor() {
    super("CLI auth for Stripe completion claim was superseded");
    this.name = "CliAuthStripeClaimLostError";
  }
}

function isCliAuthStripeClaimLostError(
  error: unknown,
): error is CliAuthStripeClaimLostError {
  return error instanceof CliAuthStripeClaimLostError;
}

async function markCliAuthStripeSessionImported(args: {
  readonly tx: Db;
  readonly sessionId: string;
  readonly claimedAt: Date;
  readonly updatedAt: Date;
}) {
  const [updated] = await args.tx
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: "imported",
        now: args.updatedAt,
      }),
    )
    .where(
      claimedCliAuthStripeSessionWhere({
        sessionId: args.sessionId,
        claimedAt: args.claimedAt,
      }),
    )
    .returning({ id: connectorCliAuthSessions.id });
  if (!updated) {
    throw new CliAuthStripeClaimLostError();
  }
}

async function importCliAuthStripeConnector(args: {
  readonly set: Setter;
  readonly sessionId: string;
  readonly claimedAt: Date;
  readonly orgId: string;
  readonly userId: string;
  readonly mode: StripeCliAuthMode;
  readonly apiKey: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<CliAuthStripeCompleteResult> {
  args.signal.throwIfAborted();

  const encryptedValue = await encryptStoredSecretValue(
    args.apiKey,
    args.featureSwitchContext,
  );
  const updatedAt = nowDate();
  const writeDb = args.set(writeDb$);
  const description = `Stripe CLI ${args.mode} mode API key`;
  await writeDb.transaction(async (tx) => {
    await lockCliAuthStripeOwner({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
    });

    await tx
      .delete(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, "stripe"),
        ),
      );

    await tx
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.type, "connector"),
          inArray(secrets.name, [...STRIPE_OAUTH_SECRET_NAMES]),
        ),
      );

    await tx
      .insert(secrets)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name: STRIPE_TOKEN_SECRET_NAME,
        encryptedValue,
        description,
        type: "user",
      })
      .onConflictDoUpdate({
        target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
        set: {
          encryptedValue,
          description,
          updatedAt,
        },
      });

    await markCliAuthStripeSessionImported({
      tx,
      sessionId: args.sessionId,
      claimedAt: args.claimedAt,
      updatedAt,
    });
  });

  await publishCliAuthStripeConnectorChanged(args.userId);

  return {
    status: "complete",
    connector: cliAuthStripeApiTokenConnector(),
  };
}

async function completeCliAuthStripeInSandbox(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly pollUrl: string;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly status: "approved" }
  | Extract<
      CliAuthStripeCompleteResult,
      { readonly status: "pending" | "error" }
    >
> {
  const completeResult = await sandboxOperation("run", () => {
    return args.client.runCommand(args.sandbox, {
      cmd: "sh",
      args: ["-lc", completeCommandScript()],
      env: {
        STRIPE_POLL_URL: args.pollUrl,
      },
      outputLimitBytes: CLI_AUTH_STRIPE_OUTPUT_LIMIT_BYTES,
      signal: args.signal,
    });
  });

  if (!completeResult.ok) {
    return {
      status: "error",
      code: "CLI_AUTH_STRIPE_FAILED",
      message: completeResult.error.message,
    };
  }

  if (isPendingCompletion(completeResult.value)) {
    return {
      status: "pending",
      errorMessage: null,
    };
  }

  if (completeResult.value.exitCode !== 0) {
    return {
      status: "error",
      code: "CLI_AUTH_STRIPE_FAILED",
      message: commandFailedMessage(
        "CLI auth for Stripe completion",
        completeResult.value,
      ),
    };
  }

  return { status: "approved" };
}

async function readCliAuthStripeApiKey(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly mode: StripeCliAuthMode;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly apiKey: string }
  | {
      readonly ok: false;
      readonly result: Extract<
        CliAuthStripeCompleteResult,
        { readonly status: "error" }
      >;
    }
> {
  const configResult = await sandboxOperation("read", () => {
    return args.client.readFile(args.sandbox, {
      path: CLI_AUTH_STRIPE_CONFIG_PATH,
      limitBytes: CLI_AUTH_STRIPE_CONFIG_LIMIT_BYTES,
      signal: args.signal,
    });
  });

  if (!configResult.ok) {
    return {
      ok: false,
      result: {
        status: "error",
        code: "CLI_AUTH_STRIPE_FAILED",
        message: configResult.error.message,
      },
    };
  }

  if (configResult.value.status !== "ok") {
    return {
      ok: false,
      result: {
        status: "error",
        code: "CLI_AUTH_STRIPE_FAILED",
        message: "CLI auth for Stripe did not produce a readable config file",
      },
    };
  }

  const configData = configResult.value.data;
  const apiKeyResult = safeSync(() => {
    return parseStripeCliAuthConfig(configData.toString("utf8"), args.mode);
  });
  if ("error" in apiKeyResult) {
    const message =
      apiKeyResult.error instanceof Error
        ? apiKeyResult.error.message
        : String(apiKeyResult.error);
    return {
      ok: false,
      result: {
        status: "error",
        code: "CLI_AUTH_STRIPE_FAILED",
        message: redactStripeCliAuthText(message),
      },
    };
  }

  return { ok: true, apiKey: apiKeyResult.ok };
}

async function loadCliAuthStripeSession(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  const [session] = await args.writeDb
    .select()
    .from(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.sessionId),
        eq(connectorCliAuthSessions.orgId, args.orgId),
        eq(connectorCliAuthSessions.userId, args.userId),
        eq(
          connectorCliAuthSessions.connectorType,
          CLI_AUTH_STRIPE_CONNECTOR_TYPE,
        ),
        eq(connectorCliAuthSessions.source, CLI_AUTH_STRIPE_SOURCE),
      ),
    )
    .limit(1);
  return session ?? null;
}

function isActiveCliAuthStripeSession(
  session: ConnectorCliAuthSession,
): boolean {
  return (
    session.status === "initializing" ||
    session.status === "awaiting_user_approval" ||
    session.status === "completing"
  );
}

function isStaleCompletingCliAuthStripeSession(
  session: ConnectorCliAuthSession,
  now: Date,
): boolean {
  return (
    session.status === "completing" &&
    now.getTime() - session.updatedAt.getTime() >
      CLI_AUTH_STRIPE_COMPLETING_STALE_MS
  );
}

async function expireCliAuthStripeSession(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly signal: AbortSignal;
}): Promise<CliAuthStripeCompleteResult> {
  const expired = await markCliAuthStripeSessionExpired({
    writeDb: args.writeDb,
    session: args.session,
  });
  if (!expired) {
    return { status: "pending", errorMessage: null };
  }
  if (args.session.sandboxId) {
    await cleanupSandbox(args.client, { sandboxId: args.session.sandboxId });
  }
  args.signal.throwIfAborted();
  return {
    status: "invalid_token",
    code: "CLI_AUTH_STRIPE_TOKEN_EXPIRED",
    message: "CLI auth for Stripe session has expired",
  };
}

async function claimCliAuthStripeSession(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly staleCompletingBefore: Date;
  readonly signal: AbortSignal;
}) {
  const [claimedSession] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "completing",
      errorMessage: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.sessionId),
        or(
          eq(connectorCliAuthSessions.status, "awaiting_user_approval"),
          and(
            eq(connectorCliAuthSessions.status, "completing"),
            lt(connectorCliAuthSessions.updatedAt, args.staleCompletingBefore),
          ),
        ),
      ),
    )
    .returning();
  args.signal.throwIfAborted();
  return claimedSession ?? null;
}

async function handleMissingCliAuthStripeProviderState(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly signal: AbortSignal;
}): Promise<CliAuthStripeErrorResult | CliAuthStripePendingResult> {
  const message = "CLI auth for Stripe session is missing provider state";
  const marked = await markCliAuthStripeSessionError({
    writeDb: args.writeDb,
    sessionId: args.session.id,
    message,
    expectedStatus: args.session.status,
    expectedUpdatedAt: args.session.updatedAt,
  });
  if (!marked) {
    return { status: "pending", errorMessage: null };
  }
  if (args.session.sandboxId) {
    await cleanupSandbox(args.client, { sandboxId: args.session.sandboxId });
  }
  args.signal.throwIfAborted();
  return {
    status: "error",
    code: "CLI_AUTH_STRIPE_FAILED",
    message,
  };
}

async function prepareCliAuthStripeCompletion(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly orgId: string;
  readonly userId: string;
  readonly sessionToken: string;
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<PreparedCliAuthStripeCompletion> {
  const sessionToken = await decodeSession(args.sessionToken);
  args.signal.throwIfAborted();
  if (!sessionToken) {
    return {
      ok: false,
      result: {
        status: "invalid_token",
        code: "CLI_AUTH_STRIPE_TOKEN_INVALID",
        message: "CLI auth for Stripe session is invalid",
      },
    };
  }

  const session = await loadCliAuthStripeSession({
    writeDb: args.writeDb,
    sessionId: sessionToken.sessionId,
    orgId: args.orgId,
    userId: args.userId,
  });
  args.signal.throwIfAborted();
  if (!session) {
    return {
      ok: false,
      result: {
        status: "forbidden",
        code: "CLI_AUTH_STRIPE_TOKEN_INVALID",
        message: "CLI auth for Stripe session was not found",
      },
    };
  }

  if (
    session.status === "completing" &&
    !isStaleCompletingCliAuthStripeSession(session, args.now)
  ) {
    return { ok: false, result: { status: "pending", errorMessage: null } };
  }

  if (isActiveCliAuthStripeSession(session) && args.now > session.expiresAt) {
    const result = await expireCliAuthStripeSession({
      writeDb: args.writeDb,
      client: args.client,
      session,
      signal: args.signal,
    });
    return { ok: false, result };
  }

  if (session.status === "initializing") {
    return { ok: false, result: { status: "pending", errorMessage: null } };
  }
  if (
    session.status !== "awaiting_user_approval" &&
    session.status !== "completing"
  ) {
    return {
      ok: false,
      result: {
        status: "invalid_token",
        code: "CLI_AUTH_STRIPE_TOKEN_INVALID",
        message: "CLI auth for Stripe session is not active",
      },
    };
  }

  const claimedSession = await claimCliAuthStripeSession({
    writeDb: args.writeDb,
    sessionId: session.id,
    staleCompletingBefore: new Date(
      args.now.getTime() - CLI_AUTH_STRIPE_COMPLETING_STALE_MS,
    ),
    signal: args.signal,
  });
  if (!claimedSession) {
    return { ok: false, result: { status: "pending", errorMessage: null } };
  }

  const providerState = await decodeProviderState(
    claimedSession.encryptedProviderState,
    args.featureSwitchContext,
  );
  args.signal.throwIfAborted();
  if (!claimedSession.sandboxId || !providerState) {
    const result = await handleMissingCliAuthStripeProviderState({
      writeDb: args.writeDb,
      client: args.client,
      session: claimedSession,
      signal: args.signal,
    });
    return { ok: false, result };
  }

  return {
    ok: true,
    session: claimedSession,
    providerState,
    sandbox: { sandboxId: claimedSession.sandboxId },
  };
}

async function resetCliAuthStripeSessionAwaitingApproval(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly claimedAt: Date;
  readonly signal: AbortSignal;
}) {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "awaiting_user_approval",
      errorMessage: null,
      updatedAt: nowDate(),
    })
    .where(
      claimedCliAuthStripeSessionWhere({
        sessionId: args.sessionId,
        claimedAt: args.claimedAt,
      }),
    )
    .returning({ id: connectorCliAuthSessions.id });
  args.signal.throwIfAborted();
  return Boolean(updated);
}

async function markClaimedCliAuthStripeSessionError(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly claimedAt: Date;
  readonly message: string;
  readonly signal: AbortSignal;
}) {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalCliAuthStripeSessionSet({
        status: "error",
        now: nowDate(),
        message: args.message,
      }),
    )
    .where(
      claimedCliAuthStripeSessionWhere({
        sessionId: args.sessionId,
        claimedAt: args.claimedAt,
      }),
    )
    .returning({ id: connectorCliAuthSessions.id });
  args.signal.throwIfAborted();
  return Boolean(updated);
}

async function completeClaimedCliAuthStripe(args: {
  readonly set: Setter;
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly providerState: CliAuthStripeProviderState;
  readonly sandbox: SandboxHandle;
  readonly orgId: string;
  readonly userId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<CliAuthStripeCompleteResult> {
  const claimedAt = args.session.updatedAt;
  const completion = await completeCliAuthStripeInSandbox({
    client: args.client,
    sandbox: args.sandbox,
    pollUrl: args.providerState.pollUrl,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (completion.status === "pending") {
    await resetCliAuthStripeSessionAwaitingApproval({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimedAt,
      signal: args.signal,
    });
    return completion;
  }
  if (completion.status === "error") {
    const claimed = await markClaimedCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimedAt,
      message: completion.message,
      signal: args.signal,
    });
    if (!claimed) {
      return { status: "pending", errorMessage: null };
    }
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return completion;
  }

  const apiKeyResult = await readCliAuthStripeApiKey({
    client: args.client,
    sandbox: args.sandbox,
    mode: args.providerState.mode,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (!apiKeyResult.ok) {
    const claimed = await markClaimedCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimedAt,
      message: apiKeyResult.result.message,
      signal: args.signal,
    });
    if (!claimed) {
      return { status: "pending", errorMessage: null };
    }
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return apiKeyResult.result;
  }

  const importResult = await settle(
    importCliAuthStripeConnector({
      set: args.set,
      sessionId: args.session.id,
      claimedAt,
      orgId: args.orgId,
      userId: args.userId,
      mode: args.providerState.mode,
      apiKey: apiKeyResult.apiKey,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    }),
  );
  if (!importResult.ok) {
    if (isCliAuthStripeClaimLostError(importResult.error)) {
      return { status: "pending", errorMessage: null };
    }
    const message = sanitizeSessionError(
      importResult.error instanceof Error
        ? importResult.error.message
        : String(importResult.error),
    );
    const claimed = await markClaimedCliAuthStripeSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimedAt,
      message,
      signal: args.signal,
    });
    if (!claimed) {
      return { status: "pending", errorMessage: null };
    }
    await cleanupSandbox(args.client, args.sandbox);
    args.signal.throwIfAborted();
    return {
      status: "error",
      code: "CLI_AUTH_STRIPE_FAILED",
      message,
    };
  }
  await cleanupSandboxSafely({
    client: args.client,
    sandbox: args.sandbox,
    reason: "import completed",
  });
  return importResult.value;
}

export const completeCliAuthStripe$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly sessionToken: string;
      readonly now?: Date;
    },
    signal: AbortSignal,
  ): Promise<CliAuthStripeCompleteResult> => {
    const writeDb = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const client = getVercelSandboxClient();
    const prepared = await prepareCliAuthStripeCompletion({
      writeDb,
      client,
      orgId: args.orgId,
      userId: args.userId,
      sessionToken: args.sessionToken,
      now: args.now ?? nowDate(),
      signal,
      featureSwitchContext,
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    return completeClaimedCliAuthStripe({
      set,
      writeDb,
      client,
      orgId: args.orgId,
      userId: args.userId,
      featureSwitchContext,
      session: prepared.session,
      providerState: prepared.providerState,
      sandbox: prepared.sandbox,
      signal,
    });
  },
);
