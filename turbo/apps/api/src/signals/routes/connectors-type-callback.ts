import { command } from "ccstate";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  getConnectorAuthMethod,
  resolveConnectorAuthClientForMethod,
  getConnectorAuthMethodGrantScopes,
  hasConnectorAuthCodeGrant,
} from "@vm0/connectors/connector-utils";
import {
  connectorAuthMethodIdSchema,
  connectorTypeSchema,
  type AuthCodeGrantConnectorType,
  type ConnectorAuthMethodId,
} from "@vm0/connectors/connectors";
import {
  exchangeConnectorAuthCode,
  type OAuthTokenResult,
} from "@vm0/connectors/auth-providers";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { optionalEnv } from "../../lib/env";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import { upsertConnectorTokenConnection$ } from "../services/zero-connector-data.service";
import {
  linkGithubVm0User,
  loadActiveGithubInstallationForOrg,
} from "../services/github-oauth.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route";
import {
  getConnectorOAuthCanonicalRedirectUrl,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  clearConnectorOAuthCookies,
  connectorOAuthRedirectResponse,
} from "./connector-oauth-route-state";

type CallbackIdentity = {
  readonly userId: string;
  readonly orgId: string;
};

type CompleteOAuthCallbackInput = {
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
  readonly identity: CallbackIdentity;
  readonly sessionId: string | undefined;
  readonly origin: string;
  readonly type: string;
};

type ResolveCallbackStateInput = {
  readonly origin: string;
  readonly type: string;
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly storedState: StoredOAuthState;
};

type ResolvedCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly sessionId: string | undefined;
      readonly authMethod: ConnectorAuthMethodId;
      readonly codeVerifier: string | undefined;
      readonly oauthContext: string | undefined;
      readonly redirectUri: string;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ClaimedCallbackState =
  | {
      readonly ok: true;
      readonly storedState: StoredOAuthState;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ResolvedAuthCodeConnectorType =
  | {
      readonly ok: true;
      readonly connectorType: AuthCodeGrantConnectorType;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

function redirectWithError(
  origin: string,
  type: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", type);
  errorUrl.searchParams.set("message", message);

  const response = connectorOAuthRedirectResponse(errorUrl.toString());
  if (clearCookies) {
    clearConnectorOAuthCookies(response);
  }
  return response;
}

function invalidStateRedirectResponse(origin: string, type: string): Response {
  return redirectWithError(
    origin,
    type,
    "Invalid state - please try again",
    true,
  );
}

function missingAuthorizationCodeRedirectResponse(
  origin: string,
  type: string,
): Response {
  return redirectWithError(origin, type, "Missing authorization code", true);
}

function missingStateRedirectResponse(origin: string, type: string): Response {
  return redirectWithError(origin, type, "Missing state parameter", true);
}

async function exchangeTokenForConnector(args: {
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  const authClient = resolveConnectorAuthClientForMethod(
    args.connectorType,
    args.authMethod,
    optionalEnv,
  );
  if (!authClient) {
    throw new Error(`${args.connectorType} OAuth not configured`);
  }

  return await exchangeConnectorAuthCode({
    type: args.connectorType,
    authClient,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
}

function getRequestedScopes(
  connectorType: AuthCodeGrantConnectorType,
  authMethod: ConnectorAuthMethodId,
): readonly string[] {
  return getConnectorAuthMethodGrantScopes(connectorType, authMethod);
}

function resolveAuthCodeConnectorType(
  origin: string,
  type: string,
): ResolvedAuthCodeConnectorType {
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return {
      ok: false,
      response: redirectWithError(origin, type, "Unknown connector type"),
    };
  }

  const connectorType = typeResult.data;
  if (!hasConnectorAuthCodeGrant(connectorType)) {
    return {
      ok: false,
      response: redirectWithError(
        origin,
        type,
        `${type} connector does not use an auth-code grant`,
      ),
    };
  }

  return { ok: true, connectorType };
}

async function claimStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<ClaimedCallbackState> {
  const storedStateResolution = await claimConnectorOAuthState(
    args.db,
    { state: args.state, connectorType: args.connectorType },
    args.signal,
  );
  if (storedStateResolution.kind === "invalid") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.type),
    };
  }
  if (storedStateResolution.kind === "missing") {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.type),
    };
  }

  return {
    ok: true,
    storedState: storedStateResolution.state,
  };
}

async function rejectInvalidStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<Response | undefined> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, connectorType: args.connectorType },
    args.signal,
  );
  if (status.kind === "usable") {
    return undefined;
  }

  return invalidStateRedirectResponse(args.origin, args.type);
}

async function completeConnectorSession(
  db: Db,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await db
    .update(connectorSessions)
    .set({
      status: "complete",
      completedAt: nowDate(),
    })
    .where(eq(connectorSessions.id, sessionId));
  signal.throwIfAborted();
}

async function markConnectorSessionError(
  db: Db,
  sessionId: string | undefined,
  errorMessage: string,
  signal: AbortSignal,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await db
    .update(connectorSessions)
    .set({
      status: "error",
      errorMessage,
    })
    .where(eq(connectorSessions.id, sessionId));
  signal.throwIfAborted();
}

function invalidStoredAuthMethodResponse(
  origin: string,
  type: string,
): Response {
  return redirectWithError(
    origin,
    type,
    "Invalid connector auth method - please try again",
    true,
  );
}

function validateStoredAuthCodeMethod(args: {
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly authMethod: string;
  readonly origin: string;
  readonly type: string;
}):
  | { readonly ok: true; readonly authMethod: ConnectorAuthMethodId }
  | { readonly ok: false; readonly response: Response } {
  const authMethodResult = connectorAuthMethodIdSchema.safeParse(
    args.authMethod,
  );
  if (!authMethodResult.success) {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(args.origin, args.type),
    };
  }

  const method = getConnectorAuthMethod(
    args.connectorType,
    authMethodResult.data,
  );
  if (!method || method.grant.kind !== "auth-code") {
    return {
      ok: false,
      response: invalidStoredAuthMethodResponse(args.origin, args.type),
    };
  }

  return { ok: true, authMethod: authMethodResult.data };
}

async function resolveTrustedCallbackAuthMethod(args: {
  readonly db: Db;
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly storedState: StoredOAuthState;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly authMethod: ConnectorAuthMethodId }
  | { readonly ok: false; readonly response: Response }
> {
  const storedAuthMethod = validateStoredAuthCodeMethod({
    connectorType: args.connectorType,
    authMethod: args.storedState.authMethod,
    origin: args.origin,
    type: args.type,
  });
  if (!storedAuthMethod.ok) {
    return storedAuthMethod;
  }

  if (!args.storedState.sessionId) {
    return storedAuthMethod;
  }

  const [session] = await args.db
    .select({
      type: connectorSessions.type,
      userId: connectorSessions.userId,
      authMethod: connectorSessions.authMethod,
    })
    .from(connectorSessions)
    .where(eq(connectorSessions.id, args.storedState.sessionId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!session) {
    return storedAuthMethod;
  }

  if (
    session.type !== args.connectorType ||
    session.userId !== args.storedState.userId ||
    session.authMethod !== args.storedState.authMethod
  ) {
    return {
      ok: false,
      response: invalidStateRedirectResponse(args.origin, args.type),
    };
  }

  return storedAuthMethod;
}

async function linkGithubIntegrationAfterConnectorConnect(args: {
  readonly db: Db;
  readonly connectorType: AuthCodeGrantConnectorType;
  readonly identity: CallbackIdentity;
  readonly token: OAuthTokenResult;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.connectorType !== "github") {
    return;
  }

  const installation = await loadActiveGithubInstallationForOrg({
    db: args.db,
    orgId: args.identity.orgId,
    signal: args.signal,
  });
  if (!installation) {
    return;
  }

  const githubUserId = await linkGithubVm0User({
    db: args.db,
    installRecordId: installation.id,
    vm0UserId: args.identity.userId,
    knownGithubUserId: args.token.userInfo.id,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (githubUserId) {
    await publishUserSignal([args.identity.userId], "github:changed");
  }
}

function successRedirectResponse(args: {
  readonly origin: string;
  readonly type: string;
  readonly username: string | null | undefined;
}): Response {
  const successUrl = new URL("/connector/success", args.origin);
  successUrl.searchParams.set("type", args.type);
  successUrl.searchParams.set("username", args.username ?? "");

  const response = connectorOAuthRedirectResponse(successUrl.toString());
  clearConnectorOAuthCookies(response);
  return response;
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "OAuth failed";
}

const completeOAuthCallback$ = command(
  async (
    { set },
    args: CompleteOAuthCallbackInput,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = await exchangeTokenForConnector({
      connectorType: args.connectorType,
      authMethod: args.authMethod,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
    signal.throwIfAborted();

    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        type: args.connectorType,
        authMethod: args.authMethod,
        accessToken: token.accessToken,
        userInfo: token.userInfo,
        oauthScopes: getRequestedScopes(args.connectorType, args.authMethod),
        refreshToken: token.refreshToken,
        expiresIn: token.expiresIn,
        extraConnectorSecrets: token.extraConnectorSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    await linkGithubIntegrationAfterConnectorConnect({
      db,
      connectorType: args.connectorType,
      identity: args.identity,
      token,
      signal,
    });
    signal.throwIfAborted();

    await completeConnectorSession(db, args.sessionId, signal);
    return successRedirectResponse({
      origin: args.origin,
      type: args.type,
      username: result.connector.externalUsername,
    });
  },
);

const resolveCallbackState$ = command(
  async (
    { set },
    args: ResolveCallbackStateInput,
    signal: AbortSignal,
  ): Promise<ResolvedCallbackState> => {
    const db = set(writeDb$);
    const authMethodResult = await resolveTrustedCallbackAuthMethod({
      db,
      connectorType: args.connectorType,
      storedState: args.storedState,
      origin: args.origin,
      type: args.type,
      signal,
    });
    signal.throwIfAborted();
    if (!authMethodResult.ok) {
      return authMethodResult;
    }

    return {
      ok: true,
      identity: {
        userId: args.storedState.userId,
        orgId: args.storedState.orgId,
      },
      sessionId: args.storedState.sessionId ?? undefined,
      authMethod: authMethodResult.authMethod,
      codeVerifier: args.storedState.codeVerifier ?? undefined,
      oauthContext: args.storedState.oauthContext ?? undefined,
      redirectUri: args.storedState.redirectUri,
    };
  },
);

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { type } = get(pathParamsOf(connectorsTypeCallbackContract.callback));
    const query = get(queryOf(connectorsTypeCallbackContract.callback));
    const request = get(request$).raw;
    const canonicalRedirectUrl = getConnectorOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return connectorOAuthRedirectResponse(canonicalRedirectUrl);
    }
    const origin = getConnectorOAuthOrigin(request);

    const connectorTypeResult = resolveAuthCodeConnectorType(origin, type);
    if (!connectorTypeResult.ok) {
      return connectorTypeResult.response;
    }
    const { connectorType } = connectorTypeResult;

    const writeDb = set(writeDb$);
    const state = query.state;
    const storedStateCallbackArgs = {
      db: writeDb,
      connectorType,
      origin,
      type,
      signal,
    };

    if (query.error) {
      if (state) {
        const claimedState = await claimStoredOAuthStateForCallback({
          ...storedStateCallbackArgs,
          state,
        });
        signal.throwIfAborted();
        if (!claimedState.ok) {
          return claimedState.response;
        }
      }
      return redirectWithError(
        origin,
        type,
        query.error_description || query.error || "OAuth authorization failed",
        true,
      );
    }

    const code = query.code;
    if (!code) {
      if (state) {
        const invalidStateResponse =
          await rejectInvalidStoredOAuthStateForCallback({
            ...storedStateCallbackArgs,
            state,
          });
        signal.throwIfAborted();
        if (invalidStateResponse) {
          return invalidStateResponse;
        }
      }
      return missingAuthorizationCodeRedirectResponse(origin, type);
    }

    if (!state) {
      return missingStateRedirectResponse(origin, type);
    }

    const claimedState = await claimStoredOAuthStateForCallback({
      ...storedStateCallbackArgs,
      state,
    });
    signal.throwIfAborted();
    if (!claimedState.ok) {
      return claimedState.response;
    }

    const resolvedState = await set(
      resolveCallbackState$,
      {
        origin,
        type,
        connectorType,
        storedState: claimedState.storedState,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!resolvedState.ok) {
      return resolvedState.response;
    }

    const callbackResult = await settle(
      set(
        completeOAuthCallback$,
        {
          connectorType,
          authMethod: resolvedState.authMethod,
          code,
          redirectUri: resolvedState.redirectUri,
          state,
          codeVerifier: resolvedState.codeVerifier,
          oauthContext: resolvedState.oauthContext,
          identity: resolvedState.identity,
          sessionId: resolvedState.sessionId,
          origin,
          type,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (callbackResult.ok) {
      return callbackResult.value;
    }

    await markConnectorSessionError(
      writeDb,
      resolvedState.sessionId,
      errorMessageFromUnknown(callbackResult.error),
      signal,
    );
    return redirectWithError(
      origin,
      type,
      "OAuth authorization failed. Please try again.",
      true,
    );
  },
);

export const connectorsTypeCallbackRoutes: readonly RouteEntry[] = [
  {
    route: connectorsTypeCallbackContract.callback,
    handler: callbackConnectorInner$,
  },
];
