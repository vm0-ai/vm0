import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type {
  ConnectorExternalCodeSessionCompleteResponse,
  ConnectorExternalCodeSessionStartResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  connectorAuthMethodIdSchema,
  connectorRefSchema,
  type ConnectorAuthMethodId,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
} from "@vm0/connectors/connector-auth-method";
import {
  completeConnectorExternalCodeAuthorizationWithMethod,
  startConnectorExternalCodeAuthorizationWithMethod,
  type ConnectorAuthProviderGrantResult,
} from "@vm0/connectors/auth-providers";
import { isOAuthProviderHttpError } from "@vm0/connectors/auth-providers/oauth/error";
import { connectorExternalCodeSessions } from "@vm0/db/schema/connector-external-code-session";
import { command } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { badRequestMessage, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { onRejection, settle, throwIfAbort } from "../utils";
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
  zeroConnectorByType,
} from "./zero-connector-data.service";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "./connected-connector-authorization.service";

const SUPERSEDABLE_EXTERNAL_CODE_SESSION_STATUSES = ["pending"] as const;
const SUPERSEDED_SESSION_ERROR_CODE = "session_superseded";
const SUPERSEDED_SESSION_ERROR_MESSAGE =
  "External-code authorization session was superseded";
const PROVIDER_STATE_MAX_BYTES = 16 * 1024;
const COMPLETING_SESSION_STALE_AFTER_MS = 30 * 60 * 1000;

type ExternalCodeSessionRow = typeof connectorExternalCodeSessions.$inferSelect;

type ExternalCodeSessionOwner = {
  readonly type: ConnectorRef;
  readonly authMethod: ConnectorAuthMethodId;
  readonly orgId: string;
  readonly userId: string;
};

type ResolvedExternalCodeClient = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly authClient: ConnectorAuthClient;
};

type CompleteSuccess = {
  readonly status: 200;
  readonly body: ConnectorExternalCodeSessionCompleteResponse;
};

const encryptedProviderStateSchema = z.object({
  connectorType: connectorRefSchema,
  authMethod: connectorAuthMethodIdSchema,
  providerState: z.string(),
});

const connectorExternalCodeDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "External-code authorization is not enabled for this connector",
      code: "FORBIDDEN",
    }),
  }),
});

function externalCodeResolutionError(
  resolution: Exclude<ConnectorActionMethodResolution, { readonly ok: true }>,
  args: {
    readonly connectorRef: ConnectorRef;
    readonly authMethodId: ConnectorAuthMethodId;
  },
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return badRequestMessage(
        `${args.connectorRef} connector is not supported`,
      );
    }
    case "unknown_auth_method": {
      const hasExternalCode = resolution.catalogConnector.authMethods.some(
        (method) => {
          return method.grantKind === "external-code";
        },
      );
      return badRequestMessage(
        hasExternalCode
          ? `${args.connectorRef} connector does not have ${args.authMethodId} auth method`
          : connectorMissingExternalCodeGrantMessage(args.connectorRef),
      );
    }
    case "wrong_grant_kind": {
      return badRequestMessage(
        `${args.connectorRef} ${args.authMethodId} auth method does not use an external-code grant`,
      );
    }
    case "hidden_auth_method": {
      return connectorExternalCodeDisabled;
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

function connectorMissingExternalCodeGrantMessage(type: string): string {
  return `${type} connector does not support an external-code grant`;
}

function resolveRequiredAuthClient(
  resolvedMethod: ResolvedConnectorActionMethod,
): ResolvedExternalCodeClient | ReturnType<typeof internalServerError> {
  if (
    resolvedMethod.method.grant.kind !== "external-code" ||
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
      `${resolvedMethod.connectorRef} auth client not configured`,
    );
  }
  return { resolvedMethod, authClient };
}

async function resolveStoredExternalCodeMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorRef: ConnectorRef;
  readonly authMethodId: string;
}) {
  const storedAuthMethod = connectorAuthMethodIdSchema.safeParse(
    args.authMethodId,
  );
  if (!storedAuthMethod.success) {
    return internalServerError("Invalid external-code authorization session");
  }
  const resolved = await args.resolver.resolveMethod({
    connectorRef: args.connectorRef,
    authMethodId: storedAuthMethod.data,
    expectedGrantKind: "external-code",
  });
  if (!resolved.ok) {
    return internalServerError("Invalid external-code authorization session");
  }
  return resolved;
}

async function lockExternalCodeSessionOwner(
  args: ExternalCodeSessionOwner & {
    readonly writeDb: Db;
  },
): Promise<void> {
  await args.writeDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_external_code:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type} || ':' || ${args.authMethod}))`,
  );
}

async function markPendingSessionsSuperseded(
  args: ExternalCodeSessionOwner & {
    readonly writeDb: Db;
    readonly now: Date;
  },
): Promise<void> {
  await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({
      status: "error",
      errorCode: SUPERSEDED_SESSION_ERROR_CODE,
      errorMessage: SUPERSEDED_SESSION_ERROR_MESSAGE,
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(connectorExternalCodeSessions.orgId, args.orgId),
        eq(connectorExternalCodeSessions.userId, args.userId),
        eq(connectorExternalCodeSessions.connectorType, args.type),
        eq(connectorExternalCodeSessions.authMethod, args.authMethod),
        inArray(connectorExternalCodeSessions.status, [
          ...SUPERSEDABLE_EXTERNAL_CODE_SESSION_STATUSES,
        ]),
      ),
    );
}

async function loadOwnedSession(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly type: ConnectorRef;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}): Promise<ExternalCodeSessionRow | null> {
  const [session] = await args.writeDb
    .select()
    .from(connectorExternalCodeSessions)
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.sessionId),
        eq(connectorExternalCodeSessions.orgId, args.orgId),
        eq(connectorExternalCodeSessions.userId, args.userId),
        eq(connectorExternalCodeSessions.connectorType, args.type),
        eq(
          connectorExternalCodeSessions.sessionTokenHash,
          sessionTokenHash(args.sessionToken),
        ),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return session ?? null;
}

async function parseEncryptedProviderState(args: {
  readonly session: ExternalCodeSessionRow;
  readonly method: ResolvedConnectorActionMethod;
}): Promise<string> {
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
  if (
    providerState.connectorType !== args.method.connectorRef ||
    providerState.authMethod !== args.method.authMethodId
  ) {
    throw new Error("External-code provider state connector method mismatch");
  }
  return providerState.providerState;
}

async function expireSession(args: {
  readonly writeDb: Db;
  readonly session: ExternalCodeSessionRow;
  readonly now: Date;
  readonly signal: AbortSignal;
}) {
  await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "External-code authorization session expired",
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.session.id),
        or(
          eq(connectorExternalCodeSessions.status, "pending"),
          eq(connectorExternalCodeSessions.status, "completing"),
        ),
      ),
    );
  args.signal.throwIfAborted();
  return badRequestMessage("External-code authorization session expired");
}

function isSessionExpired(session: ExternalCodeSessionRow, now: Date): boolean {
  return now > session.expiresAt;
}

function isCompletingSessionStale(
  session: ExternalCodeSessionRow,
  now: Date,
): boolean {
  return (
    now.getTime() - session.updatedAt.getTime() >
    COMPLETING_SESSION_STALE_AFTER_MS
  );
}

async function claimSession(args: {
  readonly writeDb: Db;
  readonly session: ExternalCodeSessionRow;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
}): Promise<ExternalCodeSessionRow | null> {
  const [claimedSession] = await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({ status: "completing", updatedAt: args.claimStartedAt })
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.session.id),
        eq(connectorExternalCodeSessions.status, "pending"),
      ),
    )
    .returning();
  args.signal.throwIfAborted();
  return claimedSession ?? null;
}

async function claimStillCurrent(args: {
  readonly writeDb: Db;
  readonly sessionId: string;
  readonly claimStartedAt: Date;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [currentClaim] = await args.writeDb
    .select({
      status: connectorExternalCodeSessions.status,
      updatedAt: connectorExternalCodeSessions.updatedAt,
    })
    .from(connectorExternalCodeSessions)
    .where(eq(connectorExternalCodeSessions.id, args.sessionId))
    .limit(1);
  args.signal.throwIfAborted();

  return (
    currentClaim?.status === "completing" &&
    currentClaim.updatedAt.getTime() === args.claimStartedAt.getTime()
  );
}

async function markClaimPending(args: {
  readonly writeDb: Db;
  readonly session: ExternalCodeSessionRow;
  readonly claimStartedAt: Date;
  readonly errorMessage?: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({
      status: "pending",
      errorCode: args.errorMessage ? "provider_rejected" : null,
      errorMessage: args.errorMessage ?? null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.session.id),
        eq(connectorExternalCodeSessions.status, "completing"),
        eq(connectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    );
  args.signal.throwIfAborted();
}

async function markClaimError(args: {
  readonly writeDb: Db;
  readonly session: ExternalCodeSessionRow;
  readonly claimStartedAt: Date;
  readonly errorMessage: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const completedAt = nowDate();
  await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({
      status: "error",
      errorCode: "complete_failed",
      errorMessage: args.errorMessage,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.session.id),
        eq(connectorExternalCodeSessions.status, "completing"),
        eq(connectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    );
  args.signal.throwIfAborted();
}

async function markClaimComplete(args: {
  readonly writeDb: Db;
  readonly session: ExternalCodeSessionRow;
  readonly claimStartedAt: Date;
  readonly connector: ConnectorResponse;
  readonly signal: AbortSignal;
}): Promise<CompleteSuccess> {
  const completedAt = nowDate();
  const [completedSession] = await args.writeDb
    .update(connectorExternalCodeSessions)
    .set({
      status: "complete",
      errorCode: null,
      errorMessage: null,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(connectorExternalCodeSessions.id, args.session.id),
        eq(connectorExternalCodeSessions.status, "completing"),
        eq(connectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    )
    .returning({ id: connectorExternalCodeSessions.id });
  args.signal.throwIfAborted();

  if (!completedSession) {
    throw new Error("External-code authorization session is no longer active");
  }
  return {
    status: 200,
    body: { status: "complete", connector: args.connector },
  };
}

async function persistClaimedConnector(
  args: ExternalCodeSessionOwner & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly session: ExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly token: ConnectorAuthProviderGrantResult;
    readonly signal: AbortSignal;
    readonly persistConnector: (args: {
      readonly token: ConnectorAuthProviderGrantResult;
      readonly signal: AbortSignal;
    }) => Promise<ConnectorResponse>;
  },
): Promise<CompleteSuccess> {
  return await args.writeDb.transaction(async (tx) => {
    await lockExternalCodeSessionOwner({
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
      throw new Error(
        "External-code authorization session is no longer active",
      );
    }

    const connector = await args.persistConnector({
      token: args.token,
      signal: args.signal,
    });
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

function terminalErrorResponse(session: ExternalCodeSessionRow) {
  switch (session.status) {
    case "expired": {
      return badRequestMessage(
        session.errorMessage ?? "External-code authorization session expired",
      );
    }
    case "error": {
      return badRequestMessage(
        session.errorMessage ?? "External-code authorization session failed",
      );
    }
    case "complete":
    case "pending":
    case "completing": {
      return null;
    }
  }
}

async function completeSessionResponse(args: {
  readonly connectorLoader: () => Promise<ConnectorResponse | null>;
  readonly signal: AbortSignal;
}): Promise<CompleteSuccess> {
  const connector = await args.connectorLoader();
  args.signal.throwIfAborted();
  if (!connector) {
    throw new Error("Completed external-code connector not found");
  }
  return { status: 200, body: { status: "complete", connector } };
}

const authorizeExternalCodeSessionConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: ExternalCodeSessionRow;
      readonly connectorType: ConnectorRef;
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
        connectorType: args.connectorType,
      },
      signal,
    );
    return authorization.status === "agentNotFound"
      ? badRequestMessage(authorization.message)
      : null;
  },
);

const completedExternalCodeSessionResponse$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: ExternalCodeSessionRow;
      readonly method: ResolvedConnectorActionMethod;
    },
    signal: AbortSignal,
  ) => {
    const response = await completeSessionResponse({
      connectorLoader: () => {
        return get(
          zeroConnectorByType({
            orgId: args.orgId,
            userId: args.userId,
            type: args.method.connectorRef,
            snapshot: args.method.snapshot,
          }),
        );
      },
      signal,
    });
    const error = await set(
      authorizeExternalCodeSessionConnector$,
      { ...args, connectorType: args.method.connectorRef },
      signal,
    );
    return error ?? response;
  },
);

async function completeClaimedExternalCodeSession(
  args: ResolvedExternalCodeClient & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly code: string;
    readonly session: ExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly signal: AbortSignal;
    readonly persistConnector: (args: {
      readonly token: ConnectorAuthProviderGrantResult;
      readonly signal: AbortSignal;
    }) => Promise<ConnectorResponse>;
  },
) {
  const providerResult = await settle(
    (async () => {
      const providerState = await parseEncryptedProviderState({
        session: args.session,
        method: args.resolvedMethod,
      });
      return await completeConnectorExternalCodeAuthorizationWithMethod({
        connectorRef: args.resolvedMethod.connectorRef,
        authMethodId: args.resolvedMethod.authMethodId,
        method: args.resolvedMethod.method,
        authClient: args.authClient,
        code: args.code,
        providerState,
        signal: args.signal,
      });
    })(),
    args.signal,
  );
  if (!providerResult.ok) {
    if (shouldRestorePendingAfterProviderError(providerResult.error)) {
      await markClaimPending({
        writeDb: args.writeDb,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        errorMessage: errorMessage(providerResult.error),
        signal: args.signal,
      });
      const badRequest = providerBadRequest(providerResult.error);
      if (badRequest) {
        return badRequest;
      }
    } else {
      await markClaimError({
        writeDb: args.writeDb,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        errorMessage: errorMessage(providerResult.error),
        signal: args.signal,
      });
    }
    throw providerResult.error;
  }

  // The provider code may already be consumed; finish DB commit even if the
  // client disconnects after provider success.
  const commitSignal = new AbortController().signal;
  const persistedConnector = await onRejection(
    persistClaimedConnector({
      type: args.resolvedMethod.connectorRef,
      authMethod: args.resolvedMethod.authMethodId,
      writeDb: args.writeDb,
      orgId: args.orgId,
      userId: args.userId,
      session: args.session,
      claimStartedAt: args.claimStartedAt,
      persistConnector: args.persistConnector,
      token: providerResult.value,
      signal: commitSignal,
    }),
    async (error) => {
      throwIfAbort(error);
      await markClaimError({
        writeDb: args.writeDb,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        errorMessage: errorMessage(error),
        signal: commitSignal,
      });
    },
  );
  return persistedConnector;
}

function providerBadRequest(error: unknown) {
  if (
    isOAuthProviderHttpError(error) &&
    (error.oauthError === "invalid_grant" ||
      (error.status >= 400 && error.status < 500 && error.status !== 429))
  ) {
    return badRequestMessage(
      "External-code authorization code was rejected. Check it and try again.",
    );
  }
  return null;
}

function shouldRestorePendingAfterProviderError(error: unknown): boolean {
  return isOAuthProviderHttpError(error);
}

function providerStateWithinLimit(providerState: string): string {
  if (Buffer.byteLength(providerState, "utf8") > PROVIDER_STATE_MAX_BYTES) {
    throw new Error(
      `External-code provider state exceeds ${PROVIDER_STATE_MAX_BYTES} bytes`,
    );
  }
  return providerState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "External-code completion failed";
}

export const startConnectorExternalCodeSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
      readonly authorizeAgent: true | undefined;
      readonly type: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
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
    const resolved = await resolver.resolveNewActionMethod({
      connectorRef: args.type,
      authMethodId: args.authMethod,
      expectedGrantKind: "external-code",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return externalCodeResolutionError(resolved, {
        connectorRef: args.type,
        authMethodId: args.authMethod,
      });
    }
    const resolvedClient = resolveRequiredAuthClient(resolved);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    const startResult = await startConnectorExternalCodeAuthorizationWithMethod(
      {
        connectorRef: resolved.connectorRef,
        authMethodId: resolved.authMethodId,
        method: resolved.method,
        authClient: resolvedClient.authClient,
      },
    );
    signal.throwIfAborted();

    const sessionToken = generateSessionToken();
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + startResult.expiresIn * 1000);
    const encryptedProviderState = await encryptPersistentSecretValue(
      JSON.stringify({
        connectorType: resolved.connectorRef,
        authMethod: resolved.authMethodId,
        providerState: providerStateWithinLimit(startResult.providerState),
      }),
      {
        orgId: args.orgId,
        userId: args.userId,
      },
    );
    signal.throwIfAborted();

    const [session] = await set(writeDb$).transaction(async (tx) => {
      await lockExternalCodeSessionOwner({
        type: resolved.connectorRef,
        authMethod: resolved.authMethodId,
        writeDb: tx,
        orgId: args.orgId,
        userId: args.userId,
      });
      await markPendingSessionsSuperseded({
        type: resolved.connectorRef,
        authMethod: resolved.authMethodId,
        writeDb: tx,
        orgId: args.orgId,
        userId: args.userId,
        now,
      });
      return await tx
        .insert(connectorExternalCodeSessions)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          authorizeAgent: connectorAgentAuthorizationRequested(args),
          connectorType: resolved.connectorRef,
          authMethod: resolved.authMethodId,
          status: "pending",
          sessionTokenHash: sessionTokenHash(sessionToken),
          encryptedProviderState,
          authorizationUrl: startResult.authorizationUrl,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        })
        .returning({ id: connectorExternalCodeSessions.id });
    });
    signal.throwIfAborted();

    if (!session) {
      throw new Error("Failed to create external-code authorization session");
    }

    const body: ConnectorExternalCodeSessionStartResponse = {
      sessionId: session.id,
      sessionToken,
      type: resolved.connectorRef,
      status: "pending",
      authorizationUrl: startResult.authorizationUrl,
      expiresIn: startResult.expiresIn,
    };
    return { status: 200 as const, body };
  },
);

export const completeConnectorExternalCodeSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ConnectorRef;
      readonly sessionId: string;
      readonly sessionToken: string;
      readonly code: string;
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
      return notFound("External-code authorization session not found");
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveStoredExternalCodeMethod({
      resolver,
      connectorRef: args.type,
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
        completedExternalCodeSessionResponse$,
        { ...args, session, method: resolvedMethod },
        signal,
      );
    }

    const terminal = terminalErrorResponse(session);
    if (terminal) {
      return terminal;
    }

    const now = nowDate();
    if (session.status === "completing") {
      if (
        isSessionExpired(session, now) &&
        isCompletingSessionStale(session, now)
      ) {
        return await expireSession({ writeDb, session, now, signal });
      }
      return badRequestMessage(
        "External-code authorization session is already completing",
      );
    }
    if (isSessionExpired(session, now)) {
      return await expireSession({ writeDb, session, now, signal });
    }

    const claimStartedAt = now;
    const claimedSession = await claimSession({
      writeDb,
      session,
      claimStartedAt,
      signal,
    });
    if (!claimedSession) {
      return badRequestMessage(
        "External-code authorization session is no longer active",
      );
    }

    const response = await completeClaimedExternalCodeSession({
      ...resolvedClient,
      writeDb,
      orgId: args.orgId,
      userId: args.userId,
      code: args.code,
      session: claimedSession,
      claimStartedAt,
      signal,
      persistConnector: async ({ token, signal: persistSignal }) => {
        const connectorResult = await set(
          upsertConnectorTokenConnection$,
          {
            orgId: args.orgId,
            userId: args.userId,
            runtimeMethod: resolvedMethod.runtimeMethod,
            snapshot: resolvedMethod.snapshot,
            outputs: token.outputs,
            userInfo: token.userInfo,
            oauthScopes: token.scopes,
            expiresIn: token.expiresIn,
            extraConnectorSecrets: token.extraConnectorSecrets,
          },
          persistSignal,
        );
        return connectorResult.connector;
      },
    });
    if (response.status !== 200) {
      return response;
    }
    const authorizationError = await set(
      authorizeExternalCodeSessionConnector$,
      { ...args, session, connectorType: resolvedMethod.connectorRef },
      signal,
    );
    return authorizationError ?? response;
  },
);
