import { createHash, randomBytes } from "node:crypto";

import type {
  ConnectorResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorType,
  type DeviceAuthGrantConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthMethodRefHasGrantKind,
  getConnectorAuthMethod,
  getConnectorAuthMethodIdsForGrantKind,
  resolveConnectorAuthClientForMethod,
  type ConnectorAuthClient,
  type ConnectorAuthMethodRef,
  type ConnectorAuthMethodRefByGrantKind,
} from "@vm0/connectors/connector-utils";
import {
  pollConnectorDeviceAuthorization,
  startConnectorDeviceAuthorization,
} from "@vm0/connectors/auth-providers";
import type {
  OAuthDeviceAuthCompleteResult,
  OAuthDeviceAuthPollResult,
} from "@vm0/connectors/auth-providers/oauth/types";
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
import { userConnectorAvailability } from "./connector-availability.service";
import {
  upsertConnectorTokenConnection$,
  zeroConnectorByType,
} from "./zero-connector-data.service";

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

const encryptedProviderStateSchema = z.object({
  connectorType: z.string(),
  deviceCode: z.string(),
});

type EncryptedProviderState = z.infer<typeof encryptedProviderStateSchema>;

type DeviceAuthMethodRef = ConnectorAuthMethodRefByGrantKind<"device-auth">;

type PollClaimedSessionArgs = DeviceAuthMethodRef & {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly authClient: ConnectorAuthClient;
  readonly session: DeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
  readonly persistConnector: (args: {
    readonly result: OAuthDeviceAuthCompleteResult;
  }) => Promise<ConnectorResponse>;
};

type ResolvedDeviceAuthMethod = DeviceAuthMethodRef;

type DeviceAuthSessionOwner = DeviceAuthMethodRef & {
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

function connectorMissingDeviceAuthGrantMessage(type: ConnectorType): string {
  if (getConnectorAuthMethodIdsForGrantKind(type, "auth-code").length === 0) {
    return `${type} connector does not use an auth-code or device-auth grant`;
  }
  return `${type} connector does not support a device-auth grant`;
}

function resolveDeviceAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ResolvedDeviceAuthMethod | ReturnType<typeof badRequestMessage> {
  const authMethodResult = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!authMethodResult.success) {
    return badRequestMessage(`${type} connector auth method is invalid`);
  }

  const authMethodRef: ConnectorAuthMethodRef = {
    type,
    authMethod: authMethodResult.data,
  };
  const method = getConnectorAuthMethod(type, authMethodResult.data);
  if (!method) {
    if (
      getConnectorAuthMethodIdsForGrantKind(type, "device-auth").length === 0
    ) {
      return badRequestMessage(connectorMissingDeviceAuthGrantMessage(type));
    }
    return badRequestMessage(
      `${type} connector does not have ${authMethod} auth method`,
    );
  }
  if (!connectorAuthMethodRefHasGrantKind(authMethodRef, "device-auth")) {
    if (
      getConnectorAuthMethodIdsForGrantKind(type, "device-auth").length === 0
    ) {
      return badRequestMessage(connectorMissingDeviceAuthGrantMessage(type));
    }
    return badRequestMessage(
      `${type} ${authMethod} auth method does not use a device-auth grant`,
    );
  }

  return authMethodRef;
}

function resolveStoredDeviceAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ResolvedDeviceAuthMethod | ReturnType<typeof internalServerError> {
  const resolved = resolveDeviceAuthMethod(type, authMethod);
  if ("status" in resolved) {
    return internalServerError("Invalid OAuth device authorization session");
  }
  return resolved;
}

function resolveRequiredAuthClient<Type extends DeviceAuthGrantConnectorType>(
  type: Type,
  authMethod: ConnectorDeviceAuthGrantAuthMethodId<Type>,
): ConnectorAuthClient | ReturnType<typeof internalServerError> {
  const authClient = resolveConnectorAuthClientForMethod(
    type,
    authMethod,
    optionalEnv,
  );
  if (!authClient) {
    return internalServerError(`${type} OAuth is not configured`);
  }
  return authClient;
}

async function lockDeviceAuthSessionOwner(
  args: DeviceAuthSessionOwner & {
    readonly writeDb: Db;
  },
): Promise<void> {
  await args.writeDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('oauth_device_authorization:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type} || ':' || ${args.authMethod}))`,
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
        eq(connectorOauthDeviceAuthorizationSessions.connectorType, args.type),
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
  readonly type: ConnectorType;
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
        eq(connectorOauthDeviceAuthorizationSessions.connectorType, args.type),
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
  readonly type: DeviceAuthGrantConnectorType;
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
  if (providerState.connectorType !== args.type) {
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
    OAuthDeviceAuthPollResult,
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
  args: DeviceAuthMethodRef & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly session: DeviceAuthSessionRow;
    readonly claimStartedAt: Date;
    readonly result: OAuthDeviceAuthCompleteResult;
    readonly signal: AbortSignal;
    readonly persistConnector: (args: {
      readonly result: OAuthDeviceAuthCompleteResult;
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

async function runClaimedSession(
  args: PollClaimedSessionArgs,
): Promise<PollSuccess> {
  const providerState = await parseEncryptedProviderState({
    session: args.session,
    type: args.type,
  });
  const pollResult = await pollConnectorDeviceAuthorization({
    type: args.type,
    authMethod: args.authMethod,
    authClient: args.authClient,
    deviceCode: providerState.deviceCode,
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
    ...args,
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
      readonly type: ConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
    },
    signal: AbortSignal,
  ) => {
    const resolvedMethod = resolveDeviceAuthMethod(args.type, args.authMethod);
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }

    const availability = await get(
      userConnectorAvailability(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    if (
      !availability.isAuthMethodAvailable(
        resolvedMethod.type,
        resolvedMethod.authMethod,
      )
    ) {
      return connectorOauthDeviceAuthDisabled;
    }

    const authClient = resolveRequiredAuthClient(
      resolvedMethod.type,
      resolvedMethod.authMethod,
    );
    if ("status" in authClient) {
      return authClient;
    }

    const startResult = await startConnectorDeviceAuthorization({
      type: resolvedMethod.type,
      authMethod: resolvedMethod.authMethod,
      authClient,
    });
    signal.throwIfAborted();

    const sessionToken = generateSessionToken();
    const intervalSeconds =
      startResult.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + startResult.expiresIn * 1000);
    const encryptedProviderState = await encryptPersistentSecretValue(
      JSON.stringify({
        connectorType: resolvedMethod.type,
        deviceCode: startResult.deviceCode,
      }),
      {
        orgId: args.orgId,
        userId: args.userId,
      },
    );
    signal.throwIfAborted();

    const [session] = await set(writeDb$).transaction(async (tx) => {
      await lockDeviceAuthSessionOwner({
        ...resolvedMethod,
        writeDb: tx,
        orgId: args.orgId,
        userId: args.userId,
      });
      await markActiveSessionsSuperseded({
        ...resolvedMethod,
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
          connectorType: resolvedMethod.type,
          authMethod: resolvedMethod.authMethod,
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

    const body: ConnectorOauthDeviceAuthSessionStartResponse = {
      sessionId: session.id,
      sessionToken,
      type: resolvedMethod.type,
      status: "pending",
      userCode: startResult.userCode,
      verificationUri: startResult.verificationUri,
      verificationUriComplete: startResult.verificationUriComplete,
      expiresIn: startResult.expiresIn,
      interval: intervalSeconds,
    };
    return { status: 200 as const, body };
  },
);

export const pollConnectorOauthDeviceAuthSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorType;
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
      type: args.type,
      sessionId: args.sessionId,
      sessionToken: args.sessionToken,
      signal,
    });
    if (!session) {
      return notFound("OAuth device authorization session not found");
    }

    const resolvedMethod = resolveStoredDeviceAuthMethod(
      args.type,
      session.authMethod,
    );
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }

    const availability = await get(
      userConnectorAvailability(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (
      !availability.isAuthMethodAvailable(
        resolvedMethod.type,
        resolvedMethod.authMethod,
      )
    ) {
      return connectorOauthDeviceAuthDisabled;
    }

    const authClient = resolveRequiredAuthClient(
      resolvedMethod.type,
      resolvedMethod.authMethod,
    );
    if ("status" in authClient) {
      return authClient;
    }

    if (session.status === "complete") {
      return await completeSessionResponse({
        connectorLoader: () => {
          return get(
            zeroConnectorByType({
              orgId: args.orgId,
              userId: args.userId,
              type: resolvedMethod.type,
              includeHiddenStoredConnector: true,
            }),
          );
        },
        signal,
      });
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

    return await pollClaimedSession({
      ...resolvedMethod,
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      authClient,
      session: claimedSession,
      claimStartedAt,
      signal,
      persistConnector: async ({ result }) => {
        const connectorResult = await set(
          upsertConnectorTokenConnection$,
          {
            orgId: args.orgId,
            userId: args.userId,
            type: resolvedMethod.type,
            authMethod: resolvedMethod.authMethod,
            accessToken: result.token.accessToken,
            userInfo: result.token.userInfo,
            oauthScopes: result.token.scopes,
            refreshToken: result.token.refreshToken,
            expiresIn: result.token.expiresIn,
            extraConnectorSecrets: result.token.extraConnectorSecrets,
          },
          signal,
        );
        return connectorResult.connector;
      },
    });
  },
);
