import { parse } from "smol-toml";
import { command, type Getter, type Setter } from "ccstate";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { getVercelSandboxClient } from "../external/vercel-sandbox";
import {
  redactSandboxMessage,
  sandboxOperation,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxHandle,
} from "../external/sandbox";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";
import { safeAsync, safeJsonParse, safeUrlParse } from "../utils";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { zeroConnectorByType } from "./zero-connector-data.service";
import { decryptSecretValue, encryptSecretValue } from "./crypto.utils";

const CLI_AUTH_STRIPE_RUNTIME = "node24";
const CLI_AUTH_STRIPE_VERSION = "1.40.9";
const CLI_AUTH_STRIPE_ARCHIVE = `stripe_${CLI_AUTH_STRIPE_VERSION}_linux_x86_64.tar.gz`;
const CLI_AUTH_STRIPE_RELEASE_URL = `https://github.com/stripe/stripe-cli/releases/download/v${CLI_AUTH_STRIPE_VERSION}`;
const CLI_AUTH_STRIPE_TIMEOUT_MS = 15 * 60 * 1000;
const CLI_AUTH_STRIPE_SESSION_TTL_SECONDS = 10 * 60;
const CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS = 5;
const CLI_AUTH_STRIPE_COMPLETE_TIMEOUT_SECONDS = 15;
const CLI_AUTH_STRIPE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const CLI_AUTH_STRIPE_CONFIG_LIMIT_BYTES = 16 * 1024;
const CLI_AUTH_STRIPE_ROOT = "/vercel/sandbox/cli-auth/stripe";
const CLI_AUTH_STRIPE_BIN_DIR = `${CLI_AUTH_STRIPE_ROOT}/bin`;
const CLI_AUTH_STRIPE_CONFIG_HOME = `${CLI_AUTH_STRIPE_ROOT}/config`;
const CLI_AUTH_STRIPE_CONFIG_PATH = `${CLI_AUTH_STRIPE_CONFIG_HOME}/stripe/config.toml`;
const STRIPE_TOKEN_SECRET_NAME = "STRIPE_TOKEN";
const STRIPE_OAUTH_SECRET_NAMES = [
  "STRIPE_ACCESS_TOKEN",
  "STRIPE_REFRESH_TOKEN",
] as const;

const cliAuthStripeOutputSchema = z.object({
  browser_url: z.url(),
  verification_code: z.string().min(1),
  next_step: z.string().min(1),
});

const cliAuthStripeSessionSchema = z.object({
  version: z.literal(1),
  type: z.literal("stripe"),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  sandboxId: z.string().min(1),
  pollUrl: z.url(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

type CliAuthStripeSession = z.infer<typeof cliAuthStripeSessionSchema>;

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

function encodeSession(payload: CliAuthStripeSession): string {
  return encryptSecretValue(JSON.stringify(payload));
}

function safeSync<T>(fn: () => T) {
  return safeAsync(() => {
    return Promise.resolve().then(fn);
  });
}

async function decodeSession(
  token: string,
): Promise<CliAuthStripeSession | null> {
  const decoded = await safeSync(() => {
    const parsed = cliAuthStripeSessionSchema.safeParse(
      safeJsonParse(decryptSecretValue(token)),
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

export async function startCliAuthStripe(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly now?: Date;
}): Promise<CliAuthStripeStartResult> {
  const client = getVercelSandboxClient();
  const createResult = await sandboxOperation("create", () => {
    return client.create({
      runtime: CLI_AUTH_STRIPE_RUNTIME,
      timeoutMs: CLI_AUTH_STRIPE_TIMEOUT_MS,
      signal: args.signal,
    });
  });

  if (!createResult.ok) {
    return {
      ok: false,
      code: "CLI_AUTH_STRIPE_UNAVAILABLE",
      message: createResult.error.message,
    };
  }

  const sandbox = createResult.value;
  const runResult = await sandboxOperation("run", () => {
    return client.runCommand(sandbox, {
      cmd: "sh",
      args: ["-lc", startCommandScript()],
      outputLimitBytes: CLI_AUTH_STRIPE_OUTPUT_LIMIT_BYTES,
      signal: args.signal,
    });
  });

  if (!runResult.ok) {
    await cleanupSandbox(client, sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      code: "CLI_AUTH_STRIPE_FAILED",
      message: runResult.error.message,
    };
  }

  if (runResult.value.exitCode !== 0) {
    await cleanupSandbox(client, sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      code: "CLI_AUTH_STRIPE_FAILED",
      message: commandFailedMessage(
        "CLI auth for Stripe start",
        runResult.value,
      ),
    };
  }

  const parsedResult = await safeSync(() => {
    const output = cliAuthStripeOutputSchema.parse(
      safeJsonParse(runResult.value.stdout.text),
    );
    const now = args.now ?? nowDate();
    const expiresAt = tokenExpiresAt(now);
    const sessionToken = encodeSession({
      version: 1,
      type: "stripe",
      orgId: args.orgId,
      userId: args.userId,
      sandboxId: sandbox.sandboxId,
      pollUrl: extractPollUrl(output.next_step),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return {
      ok: true as const,
      sessionToken,
      browserUrl: validateStripeCliUrl(output.browser_url, "browser"),
      verificationCode: output.verification_code,
      expiresIn: CLI_AUTH_STRIPE_SESSION_TTL_SECONDS,
      interval: CLI_AUTH_STRIPE_POLL_INTERVAL_SECONDS,
    };
  });
  if ("error" in parsedResult) {
    const message =
      parsedResult.error instanceof Error
        ? parsedResult.error.message
        : String(parsedResult.error);
    await cleanupSandbox(client, sandbox);
    args.signal.throwIfAborted();
    return {
      ok: false,
      code: "CLI_AUTH_STRIPE_FAILED",
      message,
    };
  }
  return parsedResult.ok;
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

function withSandboxCleanup<T>(
  operation: Promise<T>,
  client: SandboxClient,
  sandbox: SandboxHandle,
): Promise<T> {
  return operation.then(
    async (result) => {
      await cleanupSandbox(client, sandbox);
      return result;
    },
    async (error: unknown) => {
      await cleanupSandbox(client, sandbox);
      throw error;
    },
  );
}

async function importCliAuthStripeConnector(args: {
  readonly get: Getter;
  readonly set: Setter;
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
  });
  args.signal.throwIfAborted();

  await publishUserSignal([args.userId], "connector:changed");
  args.signal.throwIfAborted();

  const connector = await args.get(
    zeroConnectorByType({
      orgId: args.orgId,
      userId: args.userId,
      type: "stripe",
    }),
  );
  args.signal.throwIfAborted();
  if (!connector) {
    return {
      status: "error",
      code: "CLI_AUTH_STRIPE_FAILED",
      message: "Stripe connector was not connected after importing the key",
    };
  }

  return {
    status: "complete",
    connector,
  };
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
    const session = await decodeSession(args.sessionToken);
    signal.throwIfAborted();
    if (!session) {
      return {
        status: "invalid_token",
        code: "CLI_AUTH_STRIPE_TOKEN_INVALID",
        message: "CLI auth for Stripe session is invalid",
      };
    }

    if (session.orgId !== args.orgId || session.userId !== args.userId) {
      return {
        status: "forbidden",
        code: "CLI_AUTH_STRIPE_TOKEN_INVALID",
        message: "CLI auth for Stripe session was not found",
      };
    }

    const now = args.now ?? nowDate();
    const sandbox = { sandboxId: session.sandboxId };
    const client = getVercelSandboxClient();

    if (now > new Date(session.expiresAt)) {
      await cleanupSandbox(client, sandbox);
      signal.throwIfAborted();
      return {
        status: "invalid_token",
        code: "CLI_AUTH_STRIPE_TOKEN_EXPIRED",
        message: "CLI auth for Stripe session has expired",
      };
    }

    const completion = await completeCliAuthStripeInSandbox({
      client,
      sandbox,
      pollUrl: session.pollUrl,
      signal,
    });
    signal.throwIfAborted();
    if (completion.status === "pending") {
      return completion;
    }
    if (completion.status === "error") {
      await cleanupSandbox(client, sandbox);
      signal.throwIfAborted();
      return completion;
    }

    const apiKeyResult = await readCliAuthStripeApiKey({
      client,
      sandbox,
      signal,
    });
    signal.throwIfAborted();
    if (!apiKeyResult.ok) {
      await cleanupSandbox(client, sandbox);
      signal.throwIfAborted();
      return apiKeyResult.result;
    }

    const importResult = await safeAsync(() => {
      return withSandboxCleanup(
        importCliAuthStripeConnector({
          get,
          set,
          orgId: args.orgId,
          userId: args.userId,
          apiKey: apiKeyResult.apiKey,
          signal,
        }),
        client,
        sandbox,
      );
    });
    signal.throwIfAborted();
    if ("error" in importResult) {
      return {
        status: "error",
        code: "CLI_AUTH_STRIPE_FAILED",
        message:
          importResult.error instanceof Error
            ? importResult.error.message
            : String(importResult.error),
      };
    }
    return importResult.ok;
  },
);
