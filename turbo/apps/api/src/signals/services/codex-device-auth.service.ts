import { command, type Setter } from "ccstate";
import type { CodexDeviceAuthScope } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { and, eq } from "drizzle-orm";
import { delay } from "signal-timers";
import { z } from "zod";

import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import {
  sandboxOperation,
  type SandboxClient,
  type SandboxFileReadResult,
  type SandboxHandle,
} from "../external/sandbox";
import { getVercelSandboxClient } from "../external/vercel-sandbox";
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, safeSync, settle } from "../utils";
import { decryptSecretValue, encryptSecretValue } from "./crypto.utils";
import { handleCodexAuthJsonPaste } from "./codex-auth-json-paste-handler";
import {
  upsertOrgMultiAuthModelProvider$,
  upsertUserMultiAuthModelProvider$,
} from "./zero-model-provider.service";

const CODEX_DEVICE_AUTH_RUNTIME = "node24";
const CODEX_DEVICE_AUTH_PACKAGE = "@openai/codex@0.131.0";
const CODEX_DEVICE_AUTH_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_DEVICE_AUTH_SESSION_TTL_SECONDS = 15 * 60;
const CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const CODEX_DEVICE_AUTH_START_TIMEOUT_MS = 60 * 1000;
const CODEX_DEVICE_AUTH_START_POLL_MS = 1000;
const CODEX_DEVICE_AUTH_FILE_LIMIT_BYTES = 16 * 1024;
const CODEX_DEVICE_AUTH_ROOT = "/vercel/sandbox/cli-auth/codex";
const CODEX_DEVICE_AUTH_HOME = `${CODEX_DEVICE_AUTH_ROOT}/codex-home`;
const CODEX_DEVICE_AUTH_OUTPUT_PATH = `${CODEX_DEVICE_AUTH_ROOT}/login-output.txt`;
const CODEX_DEVICE_AUTH_STATUS_PATH = `${CODEX_DEVICE_AUTH_ROOT}/login-status.txt`;
const CODEX_DEVICE_AUTH_AUTH_JSON_PATH = `${CODEX_DEVICE_AUTH_HOME}/auth.json`;
const CODEX_DEVICE_AUTH_CONNECTOR_TYPE = "codex-oauth-token";
const CODEX_DEVICE_AUTH_SOURCE = "codex-device-auth";
const L = logger("CodexDeviceAuth");

const codexDeviceAuthSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const codexDeviceAuthProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("codex"),
  scope: z.enum(["org", "personal"]),
});

type CodexDeviceAuthSessionToken = z.infer<
  typeof codexDeviceAuthSessionTokenSchema
>;
type CodexDeviceAuthProviderState = z.infer<
  typeof codexDeviceAuthProviderStateSchema
>;
type ConnectorCliAuthSession = typeof connectorCliAuthSessions.$inferSelect;
type ConnectorCliAuthSessionStatus = ConnectorCliAuthSession["status"];
type CodexDeviceAuthFailureCode =
  | "CODEX_DEVICE_AUTH_UNAVAILABLE"
  | "CODEX_DEVICE_AUTH_FAILED"
  | "CODEX_DEVICE_AUTH_EXPIRED";

type CodexDeviceAuthStartResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly scope: CodexDeviceAuthScope;
      readonly browserUrl: string;
      readonly verificationCode: string;
      readonly expiresIn: number;
      readonly interval: number;
    }
  | {
      readonly ok: false;
      readonly code: CodexDeviceAuthFailureCode;
      readonly message: string;
    };

type CodexDeviceAuthCompleteResult =
  | {
      readonly status: "pending";
      readonly errorMessage: string | null;
    }
  | {
      readonly status: "complete";
      readonly body: {
        readonly provider: ModelProviderResponse;
        readonly created: boolean;
      };
    }
  | {
      readonly status: "invalid_token";
      readonly message: string;
    }
  | {
      readonly status: "forbidden";
      readonly message: string;
    }
  | {
      readonly status: "auth_error";
      readonly response: CodexAuthJsonPasteErrorResponse;
    }
  | {
      readonly status: "error";
      readonly code: CodexDeviceAuthFailureCode;
      readonly message: string;
    };

type TextFileReadResult =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "ok";
      readonly text: string;
    }
  | {
      readonly status: "too_large";
      readonly text: string;
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

type CodexDeviceStartOutput =
  | {
      readonly ok: true;
      readonly browserUrl: string;
      readonly verificationCode: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

type CodexAuthJsonPasteResult = Awaited<
  ReturnType<typeof handleCodexAuthJsonPaste>
>;
interface CodexAuthJsonPasteErrorResponse {
  readonly status: 400;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface CodexAuthJsonPasteSuccessBody {
  readonly provider: ModelProviderResponse;
  readonly created: boolean;
}

function startCommandScript(): string {
  return String.raw`set -euo pipefail
ROOT="${CODEX_DEVICE_AUTH_ROOT}"
CODEX_HOME="${CODEX_DEVICE_AUTH_HOME}"
HOME_DIR="$ROOT/home"
OUT="${CODEX_DEVICE_AUTH_OUTPUT_PATH}"
STATUS="${CODEX_DEVICE_AUTH_STATUS_PATH}"
mkdir -p "$ROOT" "$CODEX_HOME" "$HOME_DIR"
chmod 700 "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<'EOF'
cli_auth_credentials_store = "file"
EOF
rm -f "$OUT" "$STATUS" "${CODEX_DEVICE_AUTH_AUTH_JSON_PATH}"
(
  set +e
  HOME="$HOME_DIR" CODEX_HOME="$CODEX_HOME" npx -y ${CODEX_DEVICE_AUTH_PACKAGE} login --device-auth > "$OUT" 2>&1
  printf '%s' "$?" > "$STATUS"
) &
printf '%s' "$!" > "$ROOT/login.pid"`;
}

function encodeSession(payload: CodexDeviceAuthSessionToken): string {
  return encryptSecretValue(JSON.stringify(payload));
}

function encodeProviderState(payload: CodexDeviceAuthProviderState): string {
  return encryptSecretValue(JSON.stringify(payload));
}

function decodeSession(token: string): CodexDeviceAuthSessionToken | null {
  const decoded = safeSync(() => {
    const parsed = codexDeviceAuthSessionTokenSchema.safeParse(
      safeJsonParse(decryptSecretValue(token)),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

function decodeProviderState(
  encryptedProviderState: string | null,
): CodexDeviceAuthProviderState | null {
  if (!encryptedProviderState) {
    return null;
  }
  const decoded = safeSync(() => {
    const parsed = codexDeviceAuthProviderStateSchema.safeParse(
      safeJsonParse(decryptSecretValue(encryptedProviderState)),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

function expiresAt(now: Date): Date {
  return new Date(now.getTime() + CODEX_DEVICE_AUTH_SESSION_TTL_SECONDS * 1000);
}

function remainingTtlSeconds(expiresAtValue: Date, now: Date): number {
  return Math.max(
    1,
    Math.ceil((expiresAtValue.getTime() - now.getTime()) / 1000),
  );
}

function sanitizeSessionError(message: string): string {
  return message.slice(0, 500);
}

function terminalSessionSet(args: {
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

function ownerWhere(args: { readonly orgId: string; readonly userId: string }) {
  return and(
    eq(connectorCliAuthSessions.orgId, args.orgId),
    eq(connectorCliAuthSessions.userId, args.userId),
    eq(
      connectorCliAuthSessions.connectorType,
      CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
    ),
    eq(connectorCliAuthSessions.source, CODEX_DEVICE_AUTH_SOURCE),
  );
}

function sessionWhere(args: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(eq(connectorCliAuthSessions.id, args.sessionId), ownerWhere(args));
}

function sandboxHandleFromSession(
  session: Pick<ConnectorCliAuthSession, "sandboxId">,
): SandboxHandle | null {
  return session.sandboxId ? { sandboxId: session.sandboxId } : null;
}

async function cleanupSandboxSafely(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle | null;
  readonly reason: string;
}) {
  const sandbox = args.sandbox;
  if (!sandbox) {
    return;
  }
  const result = await sandboxOperation("stop", () => {
    return args.client.stop(sandbox);
  });
  if (!result.ok) {
    L.warn("Failed to clean up Codex device auth sandbox", {
      sandboxId: sandbox.sandboxId,
      reason: args.reason,
      error: result.error,
    });
  }
}

async function cancelActiveSessions(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly now: Date;
}): Promise<readonly SandboxHandle[]> {
  const rows = await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalSessionSet({
        status: "cancelled",
        now: args.now,
        message: "Codex device auth session was superseded",
      }),
    )
    .where(
      and(
        ownerWhere(args),
        eq(connectorCliAuthSessions.status, "awaiting_user_approval"),
      ),
    )
    .returning({ sandboxId: connectorCliAuthSessions.sandboxId });

  return rows.flatMap((row) => {
    return row.sandboxId ? [{ sandboxId: row.sandboxId }] : [];
  });
}

async function createSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly expiresAt: Date;
}): Promise<ConnectorCliAuthSession> {
  const [session] = await args.writeDb
    .insert(connectorCliAuthSessions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorType: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
      source: CODEX_DEVICE_AUTH_SOURCE,
      status: "initializing",
      expiresAt: args.expiresAt,
    })
    .returning();
  if (!session) {
    throw new Error("Failed to create Codex device auth session");
  }
  return session;
}

async function markSessionError(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly message: string;
}) {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalSessionSet({
        status: "error",
        now: nowDate(),
        message: args.message,
      }),
    )
    .where(eq(connectorCliAuthSessions.id, args.sessionId));
}

async function markSessionExpired(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
}) {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalSessionSet({
        status: "expired",
        now: nowDate(),
      }),
    )
    .where(eq(connectorCliAuthSessions.id, args.session.id));
}

async function readSandboxTextFile(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<TextFileReadResult> {
  const result = await sandboxOperation("read", () => {
    return args.client.readFile(args.sandbox, {
      path: args.path,
      limitBytes: CODEX_DEVICE_AUTH_FILE_LIMIT_BYTES,
      signal: args.signal,
    });
  });
  if (!result.ok) {
    return { status: "error", message: result.error.message };
  }
  return sandboxFileToText(result.value);
}

function sandboxFileToText(result: SandboxFileReadResult): TextFileReadResult {
  if (result.status === "missing") {
    return { status: "missing" };
  }
  const text = result.data.toString("utf8");
  if (result.status === "too_large") {
    return { status: "too_large", text };
  }
  return { status: "ok", text };
}

function stripAnsi(text: string): string {
  return text.replace(
    new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

function parseStartOutput(raw: string): CodexDeviceStartOutput | null {
  const text = stripAnsi(raw);
  const url = text.match(
    /https:\/\/auth\.openai\.com\/codex\/device[^\s'"<>]*/,
  );
  const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/);
  if (url?.[0] && code?.[0]) {
    return {
      ok: true,
      browserUrl: url[0],
      verificationCode: code[0],
    };
  }
  if (/error|failed|denied/i.test(text)) {
    return {
      ok: false,
      message: text.trim().slice(0, 500) || "Codex device auth failed",
    };
  }
  return null;
}

async function pollForStartOutput(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceStartOutput> {
  const deadline = now() + CODEX_DEVICE_AUTH_START_TIMEOUT_MS;
  while (now() < deadline) {
    const output = await readSandboxTextFile({
      ...args,
      path: CODEX_DEVICE_AUTH_OUTPUT_PATH,
    });
    args.signal.throwIfAborted();
    if (output.status === "too_large") {
      return {
        ok: false,
        message: "Codex device auth output was unexpectedly large",
      };
    }
    if (output.status === "error") {
      return { ok: false, message: output.message };
    }
    if (output.status === "ok") {
      const parsed = parseStartOutput(output.text);
      if (parsed) {
        return parsed;
      }
    }

    const status = await readSandboxTextFile({
      ...args,
      path: CODEX_DEVICE_AUTH_STATUS_PATH,
    });
    args.signal.throwIfAborted();
    if (status.status === "ok" && status.text.trim() !== "") {
      const suffix =
        output.status === "ok" && output.text.trim()
          ? `: ${output.text.trim().slice(0, 500)}`
          : "";
      return {
        ok: false,
        message: `codex login exited before printing a device code${suffix}`,
      };
    }

    await delay(CODEX_DEVICE_AUTH_START_POLL_MS, { signal: args.signal });
    args.signal.throwIfAborted();
  }
  return {
    ok: false,
    message: "Timed out waiting for Codex to print a device code",
  };
}

async function createSandbox(args: {
  readonly client: SandboxClient;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly sandbox: SandboxHandle }
  | { readonly ok: false; readonly message: string }
> {
  const result = await sandboxOperation("create", () => {
    return args.client.create({
      runtime: CODEX_DEVICE_AUTH_RUNTIME,
      timeoutMs: CODEX_DEVICE_AUTH_TIMEOUT_MS,
      signal: args.signal,
    });
  });
  if (!result.ok) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, sandbox: result.value };
}

async function runStartCommand(args: {
  readonly client: SandboxClient;
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const result = await sandboxOperation("run", () => {
    return args.client.runCommand(args.sandbox, {
      cmd: "bash",
      args: ["-lc", startCommandScript()],
      outputLimitBytes: CODEX_DEVICE_AUTH_FILE_LIMIT_BYTES,
      signal: args.signal,
    });
  });
  if (!result.ok) {
    return { ok: false, message: result.error.message };
  }
  if (result.value.exitCode !== 0) {
    const text = [result.value.stdout.text, result.value.stderr.text]
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      ok: false,
      message: text
        ? `Failed to start codex login: ${text.slice(0, 500)}`
        : "Failed to start codex login",
    };
  }
  return { ok: true };
}

async function moveSessionToAwaitingApproval(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly sandbox: SandboxHandle;
  readonly scope: CodexDeviceAuthScope;
  readonly browserUrl: string;
  readonly verificationCode: string;
}): Promise<ConnectorCliAuthSession> {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "awaiting_user_approval",
      sandboxId: args.sandbox.sandboxId,
      approvalUrl: args.browserUrl,
      verificationCode: args.verificationCode,
      encryptedProviderState: encodeProviderState({
        version: 1,
        type: "codex",
        scope: args.scope,
      }),
      updatedAt: nowDate(),
    })
    .where(eq(connectorCliAuthSessions.id, args.session.id))
    .returning();
  if (!updated) {
    throw new Error("Failed to update Codex device auth session");
  }
  return updated;
}

export async function startCodexDeviceAuth(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly scope: CodexDeviceAuthScope;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthStartResult> {
  const client = getVercelSandboxClient();
  const startedAt = nowDate();
  const cleanupSandboxes = await cancelActiveSessions({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    now: startedAt,
  });
  for (const sandbox of cleanupSandboxes) {
    await cleanupSandboxSafely({
      client,
      sandbox,
      reason: "superseded by new Codex device auth session",
    });
  }

  const session = await createSession({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    expiresAt: expiresAt(startedAt),
  });
  args.signal.throwIfAborted();

  const sandboxResult = await createSandbox({ client, signal: args.signal });
  args.signal.throwIfAborted();
  if (!sandboxResult.ok) {
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: session.id,
      message: sandboxResult.message,
    });
    return {
      ok: false,
      code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
      message: sandboxResult.message,
    };
  }

  const sandbox = sandboxResult.sandbox;
  const startResult = await runStartCommand({
    client,
    sandbox,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (!startResult.ok) {
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: session.id,
      message: startResult.message,
    });
    await cleanupSandboxSafely({
      client,
      sandbox,
      reason: "codex login start failed",
    });
    return {
      ok: false,
      code: "CODEX_DEVICE_AUTH_FAILED",
      message: startResult.message,
    };
  }

  const output = await pollForStartOutput({
    client,
    sandbox,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (!output.ok) {
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: session.id,
      message: output.message,
    });
    await cleanupSandboxSafely({
      client,
      sandbox,
      reason: "codex device code unavailable",
    });
    return {
      ok: false,
      code: "CODEX_DEVICE_AUTH_FAILED",
      message: output.message,
    };
  }

  const updated = await moveSessionToAwaitingApproval({
    writeDb: args.writeDb,
    session,
    sandbox,
    scope: args.scope,
    browserUrl: output.browserUrl,
    verificationCode: output.verificationCode,
  });
  args.signal.throwIfAborted();

  return {
    ok: true,
    sessionToken: encodeSession({ version: 1, sessionId: session.id }),
    scope: args.scope,
    browserUrl: output.browserUrl,
    verificationCode: output.verificationCode,
    expiresIn: remainingTtlSeconds(updated.expiresAt, nowDate()),
    interval: CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  };
}

async function loadSession(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ConnectorCliAuthSession | null> {
  const [session] = await args.writeDb
    .select()
    .from(connectorCliAuthSessions)
    .where(sessionWhere(args))
    .limit(1);
  return session ?? null;
}

async function claimCompleting(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
}): Promise<boolean> {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({ status: "completing", updatedAt: nowDate() })
    .where(
      and(
        eq(connectorCliAuthSessions.id, args.session.id),
        eq(connectorCliAuthSessions.status, "awaiting_user_approval"),
      ),
    )
    .returning({ id: connectorCliAuthSessions.id });
  return Boolean(updated);
}

async function markSessionImported(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
}) {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalSessionSet({
        status: "imported",
        now: nowDate(),
      }),
    )
    .where(eq(connectorCliAuthSessions.id, args.session.id));
}

function isSessionExpired(session: ConnectorCliAuthSession): boolean {
  return session.expiresAt.getTime() <= nowDate().getTime();
}

async function readAuthJson(args: {
  readonly client: SandboxClient;
  readonly session: ConnectorCliAuthSession;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly status: "pending" }
  | { readonly status: "ok"; readonly rawAuthJson: string }
  | { readonly status: "error"; readonly message: string }
> {
  const sandbox = sandboxHandleFromSession(args.session);
  if (!sandbox) {
    return {
      status: "error",
      message: "Codex device auth session lost its sandbox",
    };
  }
  const read = await readSandboxTextFile({
    client: args.client,
    sandbox,
    path: CODEX_DEVICE_AUTH_AUTH_JSON_PATH,
    signal: args.signal,
  });
  if (read.status === "missing") {
    return { status: "pending" };
  }
  if (read.status === "too_large") {
    return {
      status: "error",
      message: "Codex auth.json is unexpectedly large",
    };
  }
  if (read.status === "error") {
    return { status: "error", message: read.message };
  }
  return { status: "ok", rawAuthJson: read.text };
}

async function importCodexAuthJson(args: {
  readonly stateSet: Setter;
  readonly scope: CodexDeviceAuthScope;
  readonly orgId: string;
  readonly userId: string;
  readonly rawAuthJson: string;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly status: "complete";
      readonly body: CodexAuthJsonPasteSuccessBody;
    }
  | {
      readonly status: "auth_error";
      readonly response: CodexAuthJsonPasteErrorResponse;
    }
> {
  const common = {
    rawAuthJson: args.rawAuthJson,
    selectedModel: undefined,
    upsert: async (pasteArgs: {
      readonly authMethod: "auth_json";
      readonly secretValues: {
        readonly CHATGPT_ACCESS_TOKEN: string;
        readonly CHATGPT_REFRESH_TOKEN: string;
        readonly CHATGPT_ACCOUNT_ID: string;
        readonly CHATGPT_ID_TOKEN: string;
      };
      readonly selectedModel: string | undefined;
      readonly metadata: {
        readonly tokenExpiresAt: Date | null;
        readonly workspaceName: string | null;
        readonly planType: string | null;
      };
    }) => {
      if (args.scope === "org") {
        const result = await args.stateSet(
          upsertOrgMultiAuthModelProvider$,
          {
            orgId: args.orgId,
            type: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
            authMethod: pasteArgs.authMethod,
            secretValues: pasteArgs.secretValues,
            metadata: pasteArgs.metadata,
          },
          args.signal,
        );
        if ("status" in result) {
          throw new Error(
            "upsertOrgMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex device auth",
          );
        }
        return result;
      }
      const result = await args.stateSet(
        upsertUserMultiAuthModelProvider$,
        {
          orgId: args.orgId,
          userId: args.userId,
          type: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
          authMethod: pasteArgs.authMethod,
          secretValues: pasteArgs.secretValues,
          metadata: pasteArgs.metadata,
        },
        args.signal,
      );
      if ("status" in result) {
        throw new Error(
          "upsertUserMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex device auth",
        );
      }
      return result;
    },
  };

  const response =
    args.scope === "org"
      ? await handleCodexAuthJsonPaste({
          scope: "org",
          orgId: args.orgId,
          ...common,
        })
      : await handleCodexAuthJsonPaste({
          scope: "personal",
          orgId: args.orgId,
          userId: args.userId,
          ...common,
        });

  if (response.status === 400) {
    return {
      status: "auth_error",
      response: codexAuthJsonPasteErrorResponse(response),
    };
  }
  return {
    status: "complete",
    body: codexAuthJsonPasteSuccessBody(response),
  };
}

function extractApiErrorBody(
  body: unknown,
): CodexAuthJsonPasteErrorResponse["body"] {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    const code =
      "code" in body.error && typeof body.error.code === "string"
        ? body.error.code
        : "BAD_REQUEST";
    return { error: { message: body.error.message, code } };
  }
  return {
    error: {
      message: "Codex auth.json was rejected",
      code: "BAD_REQUEST",
    },
  };
}

function codexAuthJsonPasteErrorResponse(
  response: CodexAuthJsonPasteResult,
): CodexAuthJsonPasteErrorResponse {
  return {
    status: 400,
    body: extractApiErrorBody(response.body),
  };
}

function codexAuthJsonPasteSuccessBody(
  response: CodexAuthJsonPasteResult,
): CodexAuthJsonPasteSuccessBody {
  if (
    typeof response.body === "object" &&
    response.body !== null &&
    "provider" in response.body &&
    "created" in response.body &&
    typeof response.body.created === "boolean"
  ) {
    return response.body as CodexAuthJsonPasteSuccessBody;
  }
  throw new Error("Codex auth.json import returned an unexpected response");
}

async function completeLoadedCodexDeviceAuth(args: {
  readonly stateSet: Setter;
  readonly client: SandboxClient;
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole: "admin" | "member" | undefined;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthCompleteResult> {
  const { client, writeDb, session, signal } = args;
  if (isSessionExpired(session)) {
    await markSessionExpired({ writeDb, session });
    await cleanupSandboxSafely({
      client,
      sandbox: sandboxHandleFromSession(session),
      reason: "codex device auth session expired",
    });
    return {
      status: "invalid_token",
      message: "Codex device auth session expired",
    };
  }
  if (session.status !== "awaiting_user_approval") {
    return {
      status: "pending",
      errorMessage: session.errorMessage,
    };
  }

  const providerState = decodeProviderState(session.encryptedProviderState);
  if (!providerState) {
    return {
      status: "error",
      code: "CODEX_DEVICE_AUTH_FAILED",
      message: "Codex device auth session state is invalid",
    };
  }
  if (providerState.scope === "org" && args.orgRole !== "admin") {
    return {
      status: "forbidden",
      message: "Only admins can manage org model providers",
    };
  }

  const authJson = await readAuthJson({ client, session, signal });
  signal.throwIfAborted();
  if (authJson.status === "pending") {
    return { status: "pending", errorMessage: null };
  }
  if (authJson.status === "error") {
    await markSessionError({
      writeDb,
      sessionId: session.id,
      message: authJson.message,
    });
    await cleanupSandboxSafely({
      client,
      sandbox: sandboxHandleFromSession(session),
      reason: "codex device auth failed",
    });
    return {
      status: "error",
      code: "CODEX_DEVICE_AUTH_FAILED",
      message: authJson.message,
    };
  }

  const claimed = await claimCompleting({ writeDb, session });
  signal.throwIfAborted();
  if (!claimed) {
    return { status: "pending", errorMessage: null };
  }

  return await importClaimedCodexDeviceAuth({
    stateSet: args.stateSet,
    client,
    writeDb,
    session,
    scope: providerState.scope,
    orgId: args.orgId,
    userId: args.userId,
    rawAuthJson: authJson.rawAuthJson,
    signal,
  });
}

async function importClaimedCodexDeviceAuth(args: {
  readonly stateSet: Setter;
  readonly client: SandboxClient;
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly scope: CodexDeviceAuthScope;
  readonly orgId: string;
  readonly userId: string;
  readonly rawAuthJson: string;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthCompleteResult> {
  const imported = await settle(
    importCodexAuthJson({
      stateSet: args.stateSet,
      scope: args.scope,
      orgId: args.orgId,
      userId: args.userId,
      rawAuthJson: args.rawAuthJson,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!imported.ok) {
    const message =
      imported.error instanceof Error
        ? imported.error.message
        : "Codex device auth import failed";
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message,
    });
    await cleanupSandboxSafely({
      client: args.client,
      sandbox: sandboxHandleFromSession(args.session),
      reason: "codex device auth import failed",
    });
    return {
      status: "error",
      code: "CODEX_DEVICE_AUTH_FAILED",
      message,
    };
  }

  if (imported.value.status === "auth_error") {
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message: imported.value.response.body.error.message,
    });
    await cleanupSandboxSafely({
      client: args.client,
      sandbox: sandboxHandleFromSession(args.session),
      reason: "codex device auth auth.json rejected",
    });
    return imported.value;
  }

  await markSessionImported({ writeDb: args.writeDb, session: args.session });
  await cleanupSandboxSafely({
    client: args.client,
    sandbox: sandboxHandleFromSession(args.session),
    reason: "codex device auth imported",
  });
  return {
    status: "complete",
    body: {
      provider: imported.value.body.provider,
      created: imported.value.body.created,
    },
  };
}

export const completeCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member" | undefined;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCompleteResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Codex device auth session token",
      };
    }

    const client = getVercelSandboxClient();
    const writeDb = set(writeDb$);
    const session = await loadSession({
      writeDb,
      sessionId: decoded.sessionId,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!session) {
      return {
        status: "forbidden",
        message: "Codex device auth session not found",
      };
    }
    return await completeLoadedCodexDeviceAuth({
      stateSet: set,
      client,
      writeDb,
      session,
      orgId: args.orgId,
      userId: args.userId,
      orgRole: args.orgRole,
      signal,
    });
  },
);

export function codexDeviceAuthUnavailable(message: string) {
  return {
    status: 503 as const,
    body: {
      error: {
        message,
        code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
      },
    },
  };
}
