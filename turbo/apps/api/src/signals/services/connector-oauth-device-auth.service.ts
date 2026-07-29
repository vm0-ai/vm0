import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type {
  ConnectorResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
} from "@vm0/connectors/connector-auth-method";
import {
  pollConnectorDeviceAuthorizationWithMethod,
  startConnectorDeviceAuthorizationWithMethod,
} from "@vm0/connectors/auth-providers";
import type {
  OAuthDeviceAuthCompleteResultBase,
  OAuthDeviceAuthPollResultBase,
} from "@vm0/connectors/auth-providers/provider-flow-types";
import { connectorOauthDeviceAuthorizationSessions } from "@vm0/db/schema/connector-oauth-device-authorization-session";
import { command } from "ccstate";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { badRequestMessage, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  connectorActionResolver,
  type ConnectorActionMethodResolution,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "./connector-action-resolver.service";
import {
  upsertConnectorTokenConnection$,
  zeroConnectorBySlug,
} from "./zero-connector-data.service";
import { normalizeDeviceAuthStartOptionsWithMethod } from "./connector-catalog-form-fields.service";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "./connected-connector-authorization.service";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const POLLING_STALE_MS = 30_000;
const ACTIVE_DEVICE_AUTHORIZATION_SESSION_STATUSES = [
  "awaiting_user_authorization",
  "polling",
] as const;
const SUPERSEDED_SESSION_ERROR_CODE = "session_superseded";
const SUPERSEDED_SESSION_ERROR_MESSAGE =
  "OAuth device authorization session was superseded";

type DeviceAuthSessionRow =
  typeof connectorOauthDeviceAuthorizationSessions.$inferSelect;

type PendingPollBody = Extract<
  ConnectorOauthDeviceAuthSessionPollResponse,
  { status: "pending" }
>;

type PendingSuccess = {
  readonly status: 200;
  readonly body: PendingPollBody;
};

type PollSuccess = {
  readonly status: 200;
  readonly body: ConnectorOauthDeviceAuthSessionPollResponse;
};

function deviceAuthStartResponse(args: {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly connectorSlug: ConnectorSlug;
  readonly startResult: Awaited<
    ReturnType<typeof startConnectorDeviceAuthorizationWithMethod>
  >;
  readonly intervalSeconds: number;
}): ConnectorOauthDeviceAuthSessionStartResponse {
  return {
    sessionId: args.sessionId,
    sessionToken: args.sessionToken,
    type: args.connectorSlug,
    status: "pending",
    userCode: args.startResult.userCode,
    verificationUri: args.startResult.verificationUri,
    verificationUriComplete: args.startResult.verificationUriComplete,
    expiresIn: args.startResult.expiresIn,
    interval: args.intervalSeconds,
  };
}

const DEVICE_AUTH_POLL_STATE_MAX_BYTES = 4096;

const encryptedProviderStateSchema = z.object({
  // TODO(#23619): Rename with the persisted encrypted provider-state format.
  connectorType: connectorSlugSchema,
  deviceCode: z.string(),
  pollState: z.string().optional(),
});

type EncryptedProviderState = z.infer<typeof encryptedProviderStateSchema>;

function validatedDeviceAuthPollState(
  pollState: string | undefined,
): string | undefined {
  if (pollState === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(pollState, "utf8") > DEVICE_AUTH_POLL_STATE_MAX_BYTES) {
    throw new Error(
      `Connector OAuth device authorization provider poll state exceeds ${DEVICE_AUTH_POLL_STATE_MAX_BYTES} bytes`,
    );
  }
  return pollState;
}

type ResolvedDeviceAuthClient = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly authClient: ConnectorAuthClient;
};

type PollClaimedSessionArgs = ResolvedDeviceAuthClient & {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly session: DeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
  readonly persistConnector: (args: {
    readonly result: OAuthDeviceAuthCompleteResultBase;
  }) => Promise<ConnectorResponse>;
};

type DeviceAuthSessionOwner = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly orgId: string;
  readonly userId: string;
};

const connectorOauthDeviceAuthDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "OAuth device authorization is not enabled for this connector",
      code: "FORBIDDEN",
    }),
  }),
});

function deviceAuthResolutionError(
  resolution: Exclude<ConnectorActionMethodResolution, { readonly ok: true }>,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethodId: ConnectorAuthMethodId;
  },
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return badRequestMessage(
        `${args.connectorSlug} connector is not supported`,
      );
    }
    case "unknown_auth_method":
    case "wrong_grant_kind": {
      const hasDeviceAuth = resolution.catalogConnector.authMethods.some(
        (method) => {
          return method.grantKind === "device-auth";
        },
      );
      if (!hasDeviceAuth) {
        const hasAuthCode = resolution.catalogConnector.authMethods.some(
          (method) => {
            return method.grantKind === "auth-code";
          },
        );
        return badRequestMessage(
          hasAuthCode
            ? `${args.connectorSlug} connector does not support a device-auth grant`
            : `${args.connectorSlug} connector does not use an auth-code or device-auth grant`,
        );
      }
      if (resolution.reason === "unknown_auth_method") {
        return badRequestMessage(
          `${args.connectorSlug} connector does not have ${args.authMethodId} auth method`,
        );
      }
      return badRequestMessage(
        `${args.connectorSlug} ${args.authMethodId} auth method does not use a device-auth grant`,
      );
    }
    case "hidden_auth_method": {
      return connectorOauthDeviceAuthDisabled;
    }
    case "missing_executable_capability": {
      return internalServerError("Connector execution is not configured");
    }
  }
}

function internalServerError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: {
        message,
        code: "INTERNAL_SERVER_ERROR",
      },
    },
  };
}

function sessionTokenHash(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function terminalErrorBody(
  session: DeviceAuthSessionRow,
): ConnectorOauthDeviceAuthSessionPollResponse {
  if (
    session.status !== "denied" &&
    session.status !== "expired" &&
    session.status !== "error"
  ) {
    throw new Error(
      `Unsupported terminal OAuth device status ${session.status}`,
    );
  }
  return {
    status: session.status,
    errorCode: session.errorCode ?? undefined,
    errorMessage: session.errorMessage ?? undefined,
  };
}

function pendingBody(
  session: Pick<DeviceAuthSessionRow, "intervalSeconds">,
): PendingPollBody {
  return { status: "pending", interval: session.intervalSeconds };
}

function pendingResponse(
  session: Pick<DeviceAuthSessionRow, "intervalSeconds">,
): PendingSuccess {
  return { status: 200, body: pendingBody(session) };
}

function shouldWaitBeforeProviderPoll(
  session: DeviceAuthSessionRow,
  now: Date,
): boolean {
  return (
    session.status === "awaiting_user_authorization" &&
    session.updatedAt.getTime() > now.getTime() - session.intervalSeconds * 1000
  );
}

function isFreshPollingSession(
  session: DeviceAuthSessionRow,
  now: Date,
): boolean {
  return (
    session.status === "polling" &&
    session.updatedAt.getTime() > now.getTime() - POLLING_STALE_MS
  );
}

function resolveRequiredAuthClient(
  resolvedMethod: ResolvedConnectorActionMethod,
): ResolvedDeviceAuthClient | ReturnType<typeof internalServerError> {
  if (
    resolvedMethod.method.grant.kind !== "device-auth" ||
    resolvedMethod.method.client === undefined
  ) {
    return internalServerError("Connector execution is not configured");
  }
  const authClient = resolveConnectorAuthClient(
    resolvedMethod.method.client,
    optionalEnv,
  );
  if (!authClient) {
    return internalServerError(
      `${resolvedMethod.connectorSlug} auth client not configured`,
    );
  }
  return { resolvedMethod, authClient };
}

async function resolveRequestedDeviceAuthMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
}) {
  const resolved = await args.resolver.resolveNewActionMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: args.authMethodId,
    expectedGrantKind: "device-auth",
  });
  if (!resolved.ok) {
    return deviceAuthResolutionError(resolved, args);
  }
  return resolved;
}

async function resolveStoredDeviceAuthMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: string;
}) {
  const storedAuthMethod = connectorAuthMethodIdSchema.safeParse(
    args.authMethodId,
  );
  if (!storedAuthMethod.success) {
    return internalServerError("Invalid OAuth device authorization session");
  }
  const resolved = await args.resolver.resolveMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: storedAuthMethod.data,
    expectedGrantKind: "device-auth",
  });
  if (!resolved.ok) {
    return internalServerError("Invalid OAuth device authorization session");
  }
  return resolved;
}

async function lockDeviceAuthSessionOwner(
  args: DeviceAuthSessionOwner & {
    readonly writeDb: Db;
  },
): Promise<void> {
  await args.writeDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('oauth_device_authorization:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorSlug} || ':' || ${args.authMethod}))`,
  );
}

async function markActiveSessionsSuperseded(
  args: DeviceAuthSessionOwner & {
    readonly writeDb: Db;
    readonly now: Date;
  },
): Promise<void> {
  await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({
      status: "error",
      errorCode: SUPERSEDED_SESSION_ERROR_CODE,
      errorMessage: SUPERSEDED_SESSION_ERROR_MESSAGE,
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.orgId, args.orgId),
        eq(connectorOauthDeviceAuthorizationSessions.userId, args.userId),
        eq(
          connectorOauthDeviceAuthorizationSessions.connectorType,
          args.connectorSlug,
        ),
        eq(
          connectorOauthDeviceAuthorizationSessions.authMethod,
          args.authMethod,
        ),
        inArray(connectorOauthDeviceAuthorizationSessions.status, [
          ...ACTIVE_DEVICE_AUTHORIZATION_SESSION_STATUSES,
        ]),
      ),
    );
}

async function markClaimAwaiting(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly claimStartedAt: Date;
  readonly intervalSeconds: number;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [session] = await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({
      status: "awaiting_user_authorization",
      intervalSeconds: args.intervalSeconds,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.sessionId),
        eq(connectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          connectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning({ id: connectorOauthDeviceAuthorizationSessions.id });
  args.signal.throwIfAborted();
  return Boolean(session);
}

async function loadOwnedSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: ConnectorSlug;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}): Promise<DeviceAuthSessionRow | null> {
  const [session] = await args.writeDb
    .select()
    .from(connectorOauthDeviceAuthorizationSessions)
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.sessionId),
        eq(connectorOauthDeviceAuthorizationSessions.orgId, args.orgId),
        eq(connectorOauthDeviceAuthorizationSessions.userId, args.userId),
        eq(
          connectorOauthDeviceAuthorizationSessions.connectorType,
          args.connectorSlug,
        ),
        eq(
          connectorOauthDeviceAuthorizationSessions.sessionTokenHash,
          sessionTokenHash(args.sessionToken),
        ),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return session ?? null;
}

async function expireSession(args: {
  readonly writeDb: Db;
  readonly session: DeviceAuthSessionRow;
  readonly now: Date;
  readonly signal: AbortSignal;
}): Promise<PollSuccess> {
  const [expiredSession] = await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.session.id),
        or(
          eq(
            connectorOauthDeviceAuthorizationSessions.status,
            "awaiting_user_authorization",
          ),
          eq(connectorOauthDeviceAuthorizationSessions.status, "polling"),
        ),
      ),
    )
    .returning();
  args.signal.throwIfAborted();

  if (!expiredSession) {
    return await claimNoLongerCurrentResponse({
      writeDb: args.writeDb,
      session: args.session,
      signal: args.signal,
    });
  }
  return { status: 200, body: terminalErrorBody(expiredSession) };
}

async function claimSession(args: {
  readonly writeDb: Db;
  readonly session: DeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
}): Promise<DeviceAuthSessionRow | null> {
  const staleBefore = new Date(
    args.claimStartedAt.getTime() - POLLING_STALE_MS,
  );
  const [claimedSession] = await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({ status: "polling", updatedAt: args.claimStartedAt })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.session.id),
        or(
          eq(
            connectorOauthDeviceAuthorizationSessions.status,
            "awaiting_user_authorization",
          ),
          and(
            eq(connectorOauthDeviceAuthorizationSessions.status, "polling"),
            lt(
              connectorOauthDeviceAuthorizationSessions.updatedAt,
              staleBefore,
            ),
          ),
        ),
      ),
    )
    .returning();
  args.signal.throwIfAborted();
  return claimedSession ?? null;
}

async function parseEncryptedProviderState(args: {
  readonly session: DeviceAuthSessionRow;
  readonly connectorSlug: ConnectorSlug;
}): Promise<EncryptedProviderState> {
  const decrypted = await decryptPersistentSecretValue(
    args.session.encryptedProviderState,
    {
      orgId: args.session.orgId,
      userId: args.session.userId,
    },
  );
  const providerState = encryptedProviderStateSchema.parse(
    JSON.parse(decrypted) as unknown,
  );
  if (providerState.connectorType !== args.connectorSlug) {
    throw new Error("OAuth device provider state connector type mismatch");
  }
  return providerState;
}

async function claimStillCurrent(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [currentClaim] = await args.writeDb
    .select({
      status: connectorOauthDeviceAuthorizationSessions.status,
      updatedAt: connectorOauthDeviceAuthorizationSessions.updatedAt,
    })
    .from(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.id, args.sessionId))
    .limit(1);
  args.signal.throwIfAborted();

  return (
    currentClaim?.status === "polling" &&
    currentClaim.updatedAt.getTime() === args.claimStartedAt.getTime()
  );
}

async function claimNoLongerCurrentResponse(args: {
  readonly writeDb: Db;
  readonly session: DeviceAuthSessionRow;
  readonly signal: AbortSignal;
}): Promise<PollSuccess> {
  const [currentSession] = await args.writeDb
    .select()
    .from(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.id, args.session.id))
    .limit(1);
  args.signal.throwIfAborted();

  if (
    currentSession?.status === "denied" ||
    currentSession?.status === "expired" ||
    currentSession?.status === "error"
  ) {
    return { status: 200, body: terminalErrorBody(currentSession) };
  }
  return pendingResponse(args.session);
}

async function markClaimTerminal(args: {
  readonly writeDb: Db;
  readonly session: DeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly result: Extract<
    OAuthDeviceAuthPollResultBase,
    { readonly status: "denied" | "expired" | "error" }
  >;
  readonly signal: AbortSignal;
}): Promise<PollSuccess> {
  const completedAt = nowDate();
  const [terminalSession] = await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({
      status: args.result.status,
      errorCode: args.result.error,
      errorMessage: args.result.errorDescription,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.session.id),
        eq(connectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          connectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning();
  args.signal.throwIfAborted();

  if (!terminalSession) {
    return await claimNoLongerCurrentResponse({
      writeDb: args.writeDb,
      session: args.session,
      signal: args.signal,
    });
  }
  return { status: 200, body: terminalErrorBody(terminalSession) };
}

async function markClaimComplete(args: {
  readonly writeDb: Db;
  readonly session: DeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly connector: ConnectorResponse;
  readonly signal: AbortSignal;
}): Promise<PollSuccess> {
  const completedAt = nowDate();
  const [completedSession] = await args.writeDb
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({ status: "complete", updatedAt: completedAt, completedAt })
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.id, args.session.id),
        eq(connectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          connectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning();
  args.signal.throwIfAborted();

  if (!completedSession) {
    return await claimNoLongerCurrentResponse({
      writeDb: args.writeDb,
      session: args.session,
      signal: args.signal,
    });
  }
  return {
    status: 200,
    body: { status: "complete", connector: args.connector },
  };
}

async function completeClaimedSession(
  args: DeviceAuthSessionOwner & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly session: DeviceAuthSessionRow;
    readonly claimStartedAt: Date;
    readonly result: OAuthDeviceAuthCompleteResultBase;
    readonly signal: AbortSignal;
    readonly persistConnector: (args: {
      readonly result: OAuthDeviceAuthCompleteResultBase;
    }) => Promise<ConnectorResponse>;
  },
): Promise<PollSuccess> {
  return await args.writeDb.transaction(async (tx) => {
    await lockDeviceAuthSessionOwner({
      ...args,
      writeDb: tx,
    });
    if (
      !(await claimStillCurrent({
        writeDb: tx,
        sessionId: args.session.id,
        claimStartedAt: args.claimStartedAt,
        signal: args.signal,
      }))
    ) {
      return await claimNoLongerCurrentResponse({
        writeDb: tx,
        session: args.session,
        signal: args.signal,
      });
    }

    const connector = await args.persistConnector({ result: args.result });
    args.signal.throwIfAborted();

    return await markClaimComplete({
      writeDb: tx,
      session: args.session,
      claimStartedAt: args.claimStartedAt,
      connector,
      signal: args.signal,
    });
  });
}

async function completeSessionResponse(args: {
  readonly connectorLoader: () => Promise<ConnectorResponse | null>;
  readonly signal: AbortSignal;
}): Promise<PollSuccess> {
  const connector = await args.connectorLoader();
  args.signal.throwIfAborted();
  if (!connector) {
    throw new Error("Completed OAuth connector not found");
  }
  return { status: 200, body: { status: "complete", connector } };
}

const authorizeDeviceSessionConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: DeviceAuthSessionRow;
      readonly connectorSlug: ConnectorSlug;
    },
    signal: AbortSignal,
  ) => {
    if (!args.session.authorizeAgent) {
      return null;
    }
    const authorization = await set(
      authorizeConnectedConnector$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.session.agentId,
        connectorSlug: args.connectorSlug,
      },
      signal,
    );
    return authorization.status === "agentNotFound"
      ? badRequestMessage(authorization.message)
      : null;
  },
);

const completedDeviceSessionResponse$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: DeviceAuthSessionRow;
      readonly method: ResolvedConnectorActionMethod;
    },
    signal: AbortSignal,
  ) => {
    const response = await completeSessionResponse({
      connectorLoader: () => {
        return get(
          zeroConnectorBySlug({
            orgId: args.orgId,
            userId: args.userId,
            connectorSlug: args.method.connectorSlug,
            snapshot: args.method.snapshot,
          }),
        );
      },
      signal,
    });
    const error = await set(
      authorizeDeviceSessionConnector$,
      { ...args, connectorSlug: args.method.connectorSlug },
      signal,
    );
    return error ?? response;
  },
);

async function runClaimedSession(
  args: PollClaimedSessionArgs,
): Promise<PollSuccess> {
  const providerState = await parseEncryptedProviderState({
    session: args.session,
    connectorSlug: args.resolvedMethod.connectorSlug,
  });
  const pollResult = await pollConnectorDeviceAuthorizationWithMethod({
    connectorSlug: args.resolvedMethod.connectorSlug,
    authMethodId: args.resolvedMethod.authMethodId,
    method: args.resolvedMethod.method,
    authClient: args.authClient,
    deviceCode: providerState.deviceCode,
    ...(providerState.pollState === undefined
      ? {}
      : { pollState: providerState.pollState }),
  });
  args.signal.throwIfAborted();

  if (pollResult.status === "pending" || pollResult.status === "slow_down") {
    const intervalSeconds =
      pollResult.status === "pending"
        ? (pollResult.interval ?? args.session.intervalSeconds)
        : args.session.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS;
    const restored = await markClaimAwaiting({
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimStartedAt: args.claimStartedAt,
      intervalSeconds,
      signal: args.signal,
    });
    if (!restored) {
      return await claimNoLongerCurrentResponse({
        writeDb: args.writeDb,
        session: args.session,
        signal: args.signal,
      });
    }
    return {
      status: 200,
      body: { status: "pending", interval: intervalSeconds },
    };
  }

  if (pollResult.status !== "complete") {
    return await markClaimTerminal({
      writeDb: args.writeDb,
      session: args.session,
      claimStartedAt: args.claimStartedAt,
      result: pollResult,
      signal: args.signal,
    });
  }

  return await completeClaimedSession({
    connectorSlug: args.resolvedMethod.connectorSlug,
    authMethod: args.resolvedMethod.authMethodId,
    writeDb: args.writeDb,
    orgId: args.orgId,
    userId: args.userId,
    session: args.session,
    claimStartedAt: args.claimStartedAt,
    signal: args.signal,
    persistConnector: args.persistConnector,
    result: pollResult,
  });
}

async function pollClaimedSession(
  args: PollClaimedSessionArgs,
): Promise<PollSuccess> {
  const result = await settle(runClaimedSession(args), args.signal);
  if (result.ok) {
    return result.value;
  }

  const restored = await markClaimAwaiting({
    writeDb: args.writeDb,
    sessionId: args.session.id,
    claimStartedAt: args.claimStartedAt,
    intervalSeconds: args.session.intervalSeconds,
    signal: args.signal,
  });
  if (!restored) {
    return await claimNoLongerCurrentResponse({
      writeDb: args.writeDb,
      session: args.session,
      signal: args.signal,
    });
  }
  throw result.error;
}

export const startConnectorOauthDeviceAuthSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
      readonly authorizeAgent: true | undefined;
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly options?: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ) => {
    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      args,
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveRequestedDeviceAuthMethod({
      resolver,
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethod,
    });
    signal.throwIfAborted();
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }

    const resolvedClient = resolveRequiredAuthClient(resolvedMethod);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    const normalizedStartOptions = normalizeDeviceAuthStartOptionsWithMethod({
      connectorSlug: resolvedMethod.connectorSlug,
      authMethodId: resolvedMethod.authMethodId,
      method: resolvedMethod.method,
      options: args.options,
    });
    if (!normalizedStartOptions.ok) {
      return badRequestMessage(normalizedStartOptions.message);
    }

    const startResult = await startConnectorDeviceAuthorizationWithMethod({
      connectorSlug: resolvedMethod.connectorSlug,
      authMethodId: resolvedMethod.authMethodId,
      method: resolvedMethod.method,
      authClient: resolvedClient.authClient,
      options: normalizedStartOptions.options,
    });
    signal.throwIfAborted();

    const sessionToken = generateSessionToken();
    const intervalSeconds =
      startResult.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + startResult.expiresIn * 1000);
    const pollState = validatedDeviceAuthPollState(startResult.pollState);
    const encryptedProviderState = await encryptPersistentSecretValue(
      JSON.stringify({
        connectorType: resolvedMethod.connectorSlug,
        deviceCode: startResult.deviceCode,
        ...(pollState === undefined ? {} : { pollState }),
      }),
      {
        orgId: args.orgId,
        userId: args.userId,
      },
    );
    signal.throwIfAborted();

    const [session] = await set(writeDb$).transaction(async (tx) => {
      await lockDeviceAuthSessionOwner({
        connectorSlug: resolvedMethod.connectorSlug,
        authMethod: resolvedMethod.authMethodId,
        writeDb: tx,
        orgId: args.orgId,
        userId: args.userId,
      });
      await markActiveSessionsSuperseded({
        connectorSlug: resolvedMethod.connectorSlug,
        authMethod: resolvedMethod.authMethodId,
        writeDb: tx,
        orgId: args.orgId,
        userId: args.userId,
        now,
      });
      return await tx
        .insert(connectorOauthDeviceAuthorizationSessions)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          authorizeAgent: connectorAgentAuthorizationRequested(args),
          connectorType: resolvedMethod.connectorSlug,
          authMethod: resolvedMethod.authMethodId,
          status: "awaiting_user_authorization",
          sessionTokenHash: sessionTokenHash(sessionToken),
          encryptedProviderState,
          userCode: startResult.userCode,
          verificationUri: startResult.verificationUri,
          verificationUriComplete: startResult.verificationUriComplete,
          intervalSeconds,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        })
        .returning({
          id: connectorOauthDeviceAuthorizationSessions.id,
        });
    });
    signal.throwIfAborted();

    if (!session) {
      throw new Error("Failed to create OAuth device authorization session");
    }

    const body = deviceAuthStartResponse({
      sessionId: session.id,
      sessionToken,
      connectorSlug: resolvedMethod.connectorSlug,
      startResult,
      intervalSeconds,
    });
    return { status: 200 as const, body };
  },
);

export const pollConnectorOauthDeviceAuthSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: ConnectorSlug;
      readonly sessionId: string;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const session = await loadOwnedSession({
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      sessionId: args.sessionId,
      sessionToken: args.sessionToken,
      signal,
    });
    if (!session) {
      return notFound("OAuth device authorization session not found");
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveStoredDeviceAuthMethod({
      resolver,
      connectorSlug: args.connectorSlug,
      authMethodId: session.authMethod,
    });
    signal.throwIfAborted();
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }

    const resolvedClient = resolveRequiredAuthClient(resolvedMethod);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    if (session.status === "complete") {
      return await set(
        completedDeviceSessionResponse$,
        { ...args, session, method: resolvedMethod },
        signal,
      );
    }

    if (
      session.status === "denied" ||
      session.status === "expired" ||
      session.status === "error"
    ) {
      return { status: 200 as const, body: terminalErrorBody(session) };
    }

    const now = nowDate();
    if (shouldWaitBeforeProviderPoll(session, now)) {
      return pendingResponse(session);
    }

    if (isFreshPollingSession(session, now)) {
      return pendingResponse(session);
    }

    if (now > session.expiresAt) {
      return await expireSession({ writeDb, session, now, signal });
    }

    const claimStartedAt = nowDate();
    const claimedSession = await claimSession({
      writeDb,
      session,
      claimStartedAt,
      signal,
    });
    if (!claimedSession) {
      return await claimNoLongerCurrentResponse({ writeDb, session, signal });
    }

    const response = await pollClaimedSession({
      ...resolvedClient,
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      session: claimedSession,
      claimStartedAt,
      signal,
      persistConnector: async ({ result }) => {
        const connectorResult = await set(
          upsertConnectorTokenConnection$,
          {
            orgId: args.orgId,
            userId: args.userId,
            runtimeMethod: resolvedMethod.runtimeMethod,
            snapshot: resolvedMethod.snapshot,
            outputs: result.token.outputs,
            userInfo: result.token.userInfo,
            oauthScopes: result.token.scopes,
            expiresIn: result.token.expiresIn,
            extraConnectorSecrets: result.token.extraConnectorSecrets,
          },
          signal,
        );
        return connectorResult.connector;
      },
    });
    if (response.body.status !== "complete") {
      return response;
    }
    const authorizationError = await set(
      authorizeDeviceSessionConnector$,
      { ...args, session, connectorSlug: resolvedMethod.connectorSlug },
      signal,
    );
    return authorizationError ?? response;
  },
);
