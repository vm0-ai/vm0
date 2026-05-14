import { parse } from "smol-toml";
import { command, type Setter } from "ccstate";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { getVercelSandboxClient } from "../external/vercel-sandbox";
import {
  redactSandboxMessage,
  sandboxOperation,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxHandle,
} from "../external/sandbox";
import { connectors } from "@vm0/db/schema/connector";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { safeAsync, safeJsonParse, safeUrlParse } from "../utils";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { decryptSecretValue, encryptSecretValue } from "./crypto.utils";

const CLI_AUTH_STRIPE_RUNTIME = "node24";
const CLI_AUTH_STRIPE_VERSION = "1.40.9";
const CLI_AUTH_STRIPE_ARCHIVE = `stripe_${CLI_AUTH_STRIPE_VERSION}_linux_x86_64.tar.gz`;
const CLI_AUTH_STRIPE_RELEASE_URL = `https://github.com/stripe/stripe-cli/releases/download/v${CLI_AUTH_STRIPE_VERSION}`;
const CLI_AUTH_STRIPE_TIMEOUT_MS = 15 * 60 * 1000;
const CLI_AUTH_STRIPE_SESSION_TTL_SECONDS = 10 * 60;
const CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS = 5;
const CLI_AUTH_STRIPE_COMPLETE_TIMEOUT_SECONDS = 15;
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

const cliAuthStripeOutputSchema = z.object({
  browser_url: z.url(),
  verification_code: z.string().min(1),
  next_step: z.string().min(1),
});

const cliAuthStripeSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const cliAuthStripeProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("stripe"),
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
type ConnectorCliAuthSession = typeof connectorCliAuthSessions.$inferSelect;

type ParsedCliAuthStripeStartOutput = {
  readonly browserUrl: string;
  readonly pollUrl: string;
  readonly verificationCode: string;
};

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

function encodeProviderState(payload: CliAuthStripeProviderState): string {
  return encryptSecretValue(JSON.stringify(payload));
}

function safeSync<T>(fn: () => T) {
  return safeAsync(() => {
    return Promise.resolve().then(fn);
  });
}

async function decodeSession(
  token: string,
): Promise<CliAuthStripeSessionToken | null> {
  const decoded = await safeSync(() => {
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
): Promise<CliAuthStripeProviderState | null> {
  if (!encryptedProviderState) {
    return null;
  }
  const decoded = await safeSync(() => {
    const parsed = cliAuthStripeProviderStateSchema.safeParse(
      safeJsonParse(decryptSecretValue(encryptedProviderState)),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

function extractPollUrl(nextStep: string): string {
  const quoted = /--complete\s+(['"])(?<url>https:\/\/[^'"]+)\1/.exec(nextStep);
  const unquoted =
    quoted ?? /--complete\s+(?<url>https:\/\/\S+)/.exec(nextStep);
  const pollUrl = unquoted?.groups?.url;
  if (!pollUrl) {
    throw new Error("Stripe CLI response did not include a completion URL");
  }

  validateStripeCliUrl(pollUrl, "completion");

  return pollUrl;
}

function validateStripeCliUrl(
  url: string,
  label: "browser" | "completion",
): string {
  const parsed = safeUrlParse(url);
  if (!parsed) {
    throw new Error(`Stripe CLI response included an invalid ${label} URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "dashboard.stripe.com"
  ) {
    throw new Error(`Stripe CLI response included an unexpected ${label} URL`);
  }

  return url;
}

function commandText(result: SandboxCommandResult): string {
  return [result.stdout.text, result.stderr.text].filter(Boolean).join("\n");
}

function redactCliAuthStripeCommandText(value: string): string {
  return redactSandboxMessage(value).replace(
    /https:\/\/dashboard\.stripe\.com\/stripecli\/(?:auth|confirm_auth)[^\s'"]*/g,
    "https://dashboard.stripe.com/stripecli/[redacted]",
  );
}

function commandFailedMessage(
  phase: string,
  result: SandboxCommandResult,
): string {
  const output = redactCliAuthStripeCommandText(commandText(result).trim());
  const suffix = output ? `: ${output.slice(0, 500)}` : "";
  return `${phase} exited with code ${String(result.exitCode)}${suffix}`;
}

function isPendingCompletion(result: SandboxCommandResult): boolean {
  if (result.exitCode === 124) {
    return true;
  }
  return /exceeded max attempts/i.test(commandText(result));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripeApiKeyFromConfig(configToml: string): string {
  const parsed = parse(configToml) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Stripe CLI config is not a TOML table");
  }

  const defaultProfile = parsed.default;
  const profile = isRecord(defaultProfile) ? defaultProfile : parsed;
  const apiKey = profile.test_mode_api_key;
  if (
    typeof apiKey !== "string" ||
    !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(apiKey)
  ) {
    throw new Error("Stripe CLI config did not contain a test mode API key");
  }

  return apiKey;
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
  return redactCliAuthStripeCommandText(message).slice(0, 500);
}

async function markCliAuthStripeSessionError(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly message: string;
}) {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "error",
      errorMessage: sanitizeSessionError(args.message),
      completedAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(connectorCliAuthSessions.id, args.sessionId));
}

async function markCliAuthStripeSessionExpired(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
}) {
  const [expired] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "expired",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.session.id),
        eq(connectorCliAuthSessions.status, args.session.status),
        eq(connectorCliAuthSessions.updatedAt, args.session.updatedAt),
      ),
    )
    .returning({ id: connectorCliAuthSessions.id });
  return Boolean(expired);
}

async function createCliAuthStripeSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
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
    .returning({ id: connectorCliAuthSessions.id });
  args.signal.throwIfAborted();
  if (!session) {
    throw new Error("Failed to create CLI auth for Stripe session");
  }
  return session;
}

async function createCliAuthStripeSandbox(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly sandbox: SandboxHandle }
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
      sessionId: args.sessionId,
      message: createResult.error.message,
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
  const updateResult = await safeAsync(() => {
    return args.writeDb
      .update(connectorCliAuthSessions)
      .set({
        sandboxId: sandbox.sandboxId,
        updatedAt: nowDate(),
      })
      .where(eq(connectorCliAuthSessions.id, args.sessionId));
  });
  if ("error" in updateResult) {
    await cleanupSandbox(args.client, sandbox);
    throw updateResult.error;
  }
  args.signal.throwIfAborted();

  return { ok: true, sandbox };
}

async function parseCliAuthStripeStartOutput(
  result: SandboxCommandResult,
): Promise<
  | { readonly ok: true; readonly output: ParsedCliAuthStripeStartOutput }
  | { readonly ok: false; readonly message: string }
> {
  const parsedResult = await safeSync(() => {
    const output = cliAuthStripeOutputSchema.parse(
      safeJsonParse(result.stdout.text),
    );
    const pollUrl = extractPollUrl(output.next_step);
    const browserUrl = validateStripeCliUrl(output.browser_url, "browser");

    return {
      browserUrl,
      pollUrl,
      verificationCode: output.verification_code,
    };
  });
  if ("error" in parsedResult) {
    return {
      ok: false,
      message:
        parsedResult.error instanceof Error
          ? parsedResult.error.message
          : String(parsedResult.error),
    };
  }
  return { ok: true, output: parsedResult.ok };
}

async function runCliAuthStripeStartInSandbox(args: {
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly output: ParsedCliAuthStripeStartOutput }
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
      sessionId: args.sessionId,
      message: runResult.error.message,
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
      sessionId: args.sessionId,
      message,
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
      sessionId: args.sessionId,
      message: parsedResult.message,
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
  readonly sessionId: string;
  readonly output: ParsedCliAuthStripeStartOutput;
}) {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "awaiting_user_approval",
      approvalUrl: args.output.browserUrl,
      verificationCode: args.output.verificationCode,
      encryptedProviderState: encodeProviderState({
        version: 1,
        type: "stripe",
        pollUrl: args.output.pollUrl,
      }),
      errorMessage: null,
      updatedAt: nowDate(),
    })
    .where(eq(connectorCliAuthSessions.id, args.sessionId));
}

export async function startCliAuthStripe(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly now?: Date;
}): Promise<CliAuthStripeStartResult> {
  const session = await createCliAuthStripeSession({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    signal: args.signal,
    expiresAt: tokenExpiresAt(args.now ?? nowDate()),
  });
  const client = getVercelSandboxClient();
  const sandboxResult = await createCliAuthStripeSandbox({
    writeDb: args.writeDb,
    client,
    sessionId: session.id,
    signal: args.signal,
  });
  if (!sandboxResult.ok) {
    return sandboxResult.result;
  }

  const startResult = await runCliAuthStripeStartInSandbox({
    writeDb: args.writeDb,
    client,
    sandbox: sandboxResult.sandbox,
    sessionId: session.id,
    signal: args.signal,
  });
  if (!startResult.ok) {
    return startResult.result;
  }
  const persistResult = await safeAsync(() => {
    return markCliAuthStripeSessionAwaitingApproval({
      writeDb: args.writeDb,
      sessionId: session.id,
      output: startResult.output,
    });
  });
  if ("error" in persistResult) {
    await cleanupSandboxSafely({
      client,
      sandbox: sandboxResult.sandbox,
      reason: "start session persist failed",
    });
    throw persistResult.error;
  }
  args.signal.throwIfAborted();

  return {
    ok: true,
    sessionToken: encodeSession({
      version: 1,
      sessionId: session.id,
    }),
    browserUrl: startResult.output.browserUrl,
    verificationCode: startResult.output.verificationCode,
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
  const publishResult = await safeAsync(() => {
    return publishUserSignal([userId], "connector:changed");
  });
  if ("error" in publishResult) {
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
    .set({
      status: "imported",
      errorMessage: null,
      completedAt: args.updatedAt,
      updatedAt: args.updatedAt,
    })
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
  readonly apiKey: string;
  readonly signal: AbortSignal;
}): Promise<CliAuthStripeCompleteResult> {
  args.signal.throwIfAborted();

  const encryptedValue = encryptSecretValue(args.apiKey);
  const updatedAt = nowDate();
  const writeDb = args.set(writeDb$);
  await writeDb.transaction(async (tx) => {
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
        description: "Stripe CLI test mode restricted key",
        type: "user",
      })
      .onConflictDoUpdate({
        target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
        set: {
          encryptedValue,
          description: "Stripe CLI test mode restricted key",
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
  const apiKeyResult = await safeSync(() => {
    return stripeApiKeyFromConfig(configData.toString("utf8"));
  });
  if ("error" in apiKeyResult) {
    return {
      ok: false,
      result: {
        status: "error",
        code: "CLI_AUTH_STRIPE_FAILED",
        message:
          apiKeyResult.error instanceof Error
            ? apiKeyResult.error.message
            : String(apiKeyResult.error),
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
}): Promise<CliAuthStripeErrorResult> {
  const message = "CLI auth for Stripe session is missing provider state";
  await markCliAuthStripeSessionError({
    writeDb: args.writeDb,
    sessionId: args.session.id,
    message,
  });
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
    .set({
      status: "error",
      errorMessage: sanitizeSessionError(args.message),
      completedAt: null,
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

async function completeClaimedCliAuthStripe(args: {
  readonly set: Setter;
  readonly writeDb: Db;
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly providerState: CliAuthStripeProviderState;
  readonly sandbox: SandboxHandle;
  readonly orgId: string;
  readonly userId: string;
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

  const importResult = await safeAsync(() => {
    return importCliAuthStripeConnector({
      set: args.set,
      sessionId: args.session.id,
      claimedAt,
      orgId: args.orgId,
      userId: args.userId,
      apiKey: apiKeyResult.apiKey,
      signal: args.signal,
    });
  });
  if ("error" in importResult) {
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
  return importResult.ok;
}

export const completeCliAuthStripe$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly sessionToken: string;
      readonly now?: Date;
    },
    signal: AbortSignal,
  ): Promise<CliAuthStripeCompleteResult> => {
    const writeDb = set(writeDb$);
    const client = getVercelSandboxClient();
    const prepared = await prepareCliAuthStripeCompletion({
      writeDb,
      client,
      orgId: args.orgId,
      userId: args.userId,
      sessionToken: args.sessionToken,
      now: args.now ?? nowDate(),
      signal,
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
      session: prepared.session,
      providerState: prepared.providerState,
      sandbox: prepared.sandbox,
      signal,
    });
  },
);
