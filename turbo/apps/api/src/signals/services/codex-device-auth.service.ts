import { command, type Setter } from "ccstate";
import type { CodexDeviceAuthScope } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  detach,
  Mechanism,
  onRejection,
  safeJsonParse,
  safeSync,
  settle,
} from "../utils";
import { decryptSecretValue, encryptSecretValue } from "./crypto.utils";
import { handleCodexAuthJsonPaste } from "./codex-auth-json-paste-handler";
import {
  upsertOrgMultiAuthModelProvider$,
  upsertUserMultiAuthModelProvider$,
} from "./zero-model-provider.service";

const CODEX_DEVICE_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_DEVICE_AUTH_API_BASE_URL = `${CODEX_DEVICE_AUTH_ISSUER}/api/accounts`;
const CODEX_DEVICE_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_AUTH_VERIFICATION_URL = `${CODEX_DEVICE_AUTH_ISSUER}/codex/device`;
const CODEX_DEVICE_AUTH_REDIRECT_URI = `${CODEX_DEVICE_AUTH_ISSUER}/deviceauth/callback`;
const CODEX_DEVICE_AUTH_SESSION_TTL_SECONDS = 15 * 60;
const CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const CODEX_DEVICE_AUTH_CONNECTOR_TYPE = "codex-oauth-token";
const CODEX_DEVICE_AUTH_SOURCE = "codex-device-auth";

const codexDeviceAuthSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const codexDeviceAuthProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("codex"),
  scope: z.enum(["org", "personal"]),
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
});

const codexDeviceUserCodeResponseSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.coerce
    .number()
    .int()
    .positive()
    .default(CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS),
});

const codexDeviceTokenResponseSchema = z.object({
  authorization_code: z.string().min(1),
  code_challenge: z.string().min(1),
  code_verifier: z.string().min(1),
});

const codexOAuthTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

type CodexDeviceAuthSessionToken = z.infer<
  typeof codexDeviceAuthSessionTokenSchema
>;
type CodexDeviceAuthProviderState = z.infer<
  typeof codexDeviceAuthProviderStateSchema
>;
type ConnectorCliAuthSession = typeof connectorCliAuthSessions.$inferSelect;
type ConnectorCliAuthSessionStatus = ConnectorCliAuthSession["status"];
const CODEX_DEVICE_AUTH_ACTIVE_STATUSES = [
  "initializing",
  "awaiting_user_approval",
  "completing",
] as const satisfies readonly ConnectorCliAuthSessionStatus[];
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

type CodexDeviceAuthCancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "invalid_token"; readonly message: string }
  | { readonly status: "forbidden"; readonly message: string };

type CodexDeviceUserCode = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly interval: number;
};

type CodexDeviceTokenPollResult =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "complete";
      readonly authorizationCode: string;
      readonly codeVerifier: string;
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

type CodexOAuthTokens = {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
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

function unknownErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

async function cancelActiveSessions(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly now: Date;
}): Promise<void> {
  await args.writeDb
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
        inArray(connectorCliAuthSessions.status, [
          ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
        ]),
      ),
    );
}

async function cancelSession(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly message: string;
}): Promise<void> {
  await args.writeDb
    .update(connectorCliAuthSessions)
    .set(
      terminalSessionSet({
        status: "cancelled",
        now: nowDate(),
        message: args.message,
      }),
    )
    .where(
      and(
        sessionWhere({
          sessionId: args.sessionId,
          orgId: args.orgId,
          userId: args.userId,
        }),
        inArray(connectorCliAuthSessions.status, [
          ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
        ]),
      ),
    );
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

function registerStartAbortCancellation(args: {
  readonly signal: AbortSignal;
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly orgId: string;
  readonly userId: string;
}): () => void {
  const cleanupOnAbort = () => {
    detach(
      cancelSession({
        writeDb: args.writeDb,
        sessionId: args.session.id,
        orgId: args.orgId,
        userId: args.userId,
        message: "Codex device auth session was cancelled",
      }),
      Mechanism.WaitUntil,
      "cancel aborted Codex device auth session",
    );
  };
  args.signal.addEventListener("abort", cleanupOnAbort, { once: true });
  return () => {
    args.signal.removeEventListener("abort", cleanupOnAbort);
  };
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

async function moveSessionToAwaitingApproval(args: {
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly scope: CodexDeviceAuthScope;
  readonly deviceAuthId: string;
  readonly userCode: string;
}): Promise<ConnectorCliAuthSession> {
  const [updated] = await args.writeDb
    .update(connectorCliAuthSessions)
    .set({
      status: "awaiting_user_approval",
      approvalUrl: CODEX_DEVICE_AUTH_VERIFICATION_URL,
      verificationCode: args.userCode,
      encryptedProviderState: encodeProviderState({
        version: 1,
        type: "codex",
        scope: args.scope,
        deviceAuthId: args.deviceAuthId,
        userCode: args.userCode,
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

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    throw new Error("OpenAI auth returned invalid JSON");
  }
  return parsed;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text();
  const trimmed = text.trim();
  return trimmed
    ? `${fallback}: ${trimmed.slice(0, 500)}`
    : `${fallback} with status ${response.status}`;
}

async function requestOpenAiDeviceUserCode(
  signal: AbortSignal,
): Promise<CodexDeviceUserCode> {
  const response = await fetch(
    `${CODEX_DEVICE_AUTH_API_BASE_URL}/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_DEVICE_AUTH_CLIENT_ID }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Codex device code request failed"),
    );
  }

  const parsed = codexDeviceUserCodeResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    throw new Error(
      "OpenAI auth returned an unrecognized device code response",
    );
  }
  const userCode = parsed.data.user_code ?? parsed.data.usercode;
  if (!userCode) {
    throw new Error("OpenAI auth returned a device code response without code");
  }
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    interval: parsed.data.interval,
  };
}

async function pollOpenAiDeviceToken(args: {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceTokenPollResult> {
  const response = await fetch(
    `${CODEX_DEVICE_AUTH_API_BASE_URL}/deviceauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: args.deviceAuthId,
        user_code: args.userCode,
      }),
      signal: args.signal,
    },
  );

  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  if (!response.ok) {
    return {
      status: "error",
      message: await readErrorMessage(response, "Codex device auth failed"),
    };
  }

  const parsed = codexDeviceTokenResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    return {
      status: "error",
      message: "OpenAI auth returned an unrecognized device token response",
    };
  }
  return {
    status: "complete",
    authorizationCode: parsed.data.authorization_code,
    codeVerifier: parsed.data.code_verifier,
  };
}

async function exchangeOpenAiAuthorizationCode(args: {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly signal: AbortSignal;
}): Promise<CodexOAuthTokens> {
  const response = await fetch(`${CODEX_DEVICE_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.authorizationCode,
      redirect_uri: CODEX_DEVICE_AUTH_REDIRECT_URI,
      client_id: CODEX_DEVICE_AUTH_CLIENT_ID,
      code_verifier: args.codeVerifier,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Codex token exchange failed"),
    );
  }

  const parsed = codexOAuthTokenResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    throw new Error("OpenAI auth returned an unrecognized token response");
  }
  return {
    idToken: parsed.data.id_token,
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
  };
}

export async function startCodexDeviceAuth(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly scope: CodexDeviceAuthScope;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthStartResult> {
  const startedAt = nowDate();
  await cancelActiveSessions({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    now: startedAt,
  });

  const session = await createSession({
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    expiresAt: expiresAt(startedAt),
  });
  const unregisterAbortCancellation = registerStartAbortCancellation({
    signal: args.signal,
    writeDb: args.writeDb,
    session,
    orgId: args.orgId,
    userId: args.userId,
  });
  const userCodeResult = await onRejection(
    settle(requestOpenAiDeviceUserCode(args.signal), args.signal),
    unregisterAbortCancellation,
  );
  unregisterAbortCancellation();
  args.signal.throwIfAborted();
  if (!userCodeResult.ok) {
    const message = unknownErrorMessage(
      userCodeResult.error,
      "Codex device code request failed",
    );
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: session.id,
      message,
    });
    return {
      ok: false,
      code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
      message,
    };
  }

  const updated = await moveSessionToAwaitingApproval({
    writeDb: args.writeDb,
    session,
    scope: args.scope,
    deviceAuthId: userCodeResult.value.deviceAuthId,
    userCode: userCodeResult.value.userCode,
  });
  args.signal.throwIfAborted();

  return {
    ok: true,
    sessionToken: encodeSession({ version: 1, sessionId: session.id }),
    scope: args.scope,
    browserUrl: CODEX_DEVICE_AUTH_VERIFICATION_URL,
    verificationCode: userCodeResult.value.userCode,
    expiresIn: remainingTtlSeconds(updated.expiresAt, nowDate()),
    interval: userCodeResult.value.interval,
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
      message: "Codex login tokens were rejected",
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
  throw new Error("Codex login token import returned an unexpected response");
}

function authJsonFromTokens(tokens: CodexOAuthTokens): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: "device-auth",
      id_token: tokens.idToken,
    },
  });
}

async function completeLoadedCodexDeviceAuth(args: {
  readonly stateSet: Setter;
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole: "admin" | "member" | undefined;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthCompleteResult> {
  const { writeDb, session, signal } = args;
  if (isSessionExpired(session)) {
    await markSessionExpired({ writeDb, session });
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

  const deviceToken = await pollOpenAiDeviceToken({
    deviceAuthId: providerState.deviceAuthId,
    userCode: providerState.userCode,
    signal,
  });
  signal.throwIfAborted();
  if (deviceToken.status === "pending") {
    return { status: "pending", errorMessage: null };
  }
  if (deviceToken.status === "error") {
    await markSessionError({
      writeDb,
      sessionId: session.id,
      message: deviceToken.message,
    });
    return {
      status: "error",
      code: "CODEX_DEVICE_AUTH_FAILED",
      message: deviceToken.message,
    };
  }

  const claimed = await claimCompleting({ writeDb, session });
  signal.throwIfAborted();
  if (!claimed) {
    return { status: "pending", errorMessage: null };
  }

  return await importClaimedCodexDeviceAuth({
    stateSet: args.stateSet,
    writeDb,
    session,
    scope: providerState.scope,
    orgId: args.orgId,
    userId: args.userId,
    authorizationCode: deviceToken.authorizationCode,
    codeVerifier: deviceToken.codeVerifier,
    signal,
  });
}

async function importClaimedCodexDeviceAuth(args: {
  readonly stateSet: Setter;
  readonly writeDb: Db;
  readonly session: ConnectorCliAuthSession;
  readonly scope: CodexDeviceAuthScope;
  readonly orgId: string;
  readonly userId: string;
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly signal: AbortSignal;
}): Promise<CodexDeviceAuthCompleteResult> {
  const tokens = await settle(
    exchangeOpenAiAuthorizationCode({
      authorizationCode: args.authorizationCode,
      codeVerifier: args.codeVerifier,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!tokens.ok) {
    const message = unknownErrorMessage(
      tokens.error,
      "Codex device auth token exchange failed",
    );
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message,
    });
    return {
      status: "error",
      code: "CODEX_DEVICE_AUTH_FAILED",
      message,
    };
  }

  const imported = await settle(
    importCodexAuthJson({
      stateSet: args.stateSet,
      scope: args.scope,
      orgId: args.orgId,
      userId: args.userId,
      rawAuthJson: authJsonFromTokens(tokens.value),
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!imported.ok) {
    const message = unknownErrorMessage(
      imported.error,
      "Codex device auth import failed",
    );
    await markSessionError({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      message,
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
    return imported.value;
  }

  await markSessionImported({ writeDb: args.writeDb, session: args.session });
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
      writeDb,
      session,
      orgId: args.orgId,
      userId: args.userId,
      orgRole: args.orgRole,
      signal,
    });
  },
);

export const cancelCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCancelResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Codex device auth session token",
      };
    }

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

    await cancelSession({
      writeDb,
      sessionId: session.id,
      orgId: args.orgId,
      userId: args.userId,
      message: "Codex device auth session was cancelled",
    });
    signal.throwIfAborted();

    return { status: "cancelled" };
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
