import { unescape as decodeCookieComponent } from "node:querystring";

import { command } from "ccstate";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  getConnectorOAuthCredentials,
  getOAuthConnectorConfig,
  isStaticConfidentialConnectorOAuthCredentials,
  isStaticConnectorOAuthCredentials,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type OAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  isOAuthConnectorType,
  CONNECTOR_OAUTH_PROVIDERS,
  type OAuthTokenResult,
} from "@vm0/connectors/oauth-providers";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { and, eq, gt } from "drizzle-orm";

import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { optionalEnv } from "../../lib/env";
import {
  claimConnectorOAuthState,
  getConnectorOAuthStateStatus,
  type StoredOAuthState,
} from "../services/connector-oauth-state.service";
import {
  completeOAuthConnectorSession$,
  upsertOAuthConnector$,
} from "../services/zero-connector-data.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route";
import {
  getConnectorOAuthCanonicalRedirectUrl,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";
import {
  clearOAuthCookies,
  CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME,
  CONNECTOR_OAUTH_PKCE_COOKIE_NAME,
  CONNECTOR_OAUTH_SESSION_COOKIE_NAME,
  CONNECTOR_OAUTH_STATE_COOKIE_NAME,
  parseConnectorOAuthSessionId,
  redirectResponse,
} from "./connector-oauth-route-state";

type CallbackIdentity = {
  readonly userId: string;
  readonly orgId: string;
};

type CompleteOAuthCallbackInput = {
  readonly connectorType: OAuthConnectorType;
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

type CallbackCookies = {
  readonly savedState: string | undefined;
  readonly sessionId: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
};

type ResolveCallbackStateInput = {
  readonly origin: string;
  readonly type: string;
  readonly savedState: string | undefined;
  readonly state: string;
  readonly sessionId: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
  readonly storedState: StoredOAuthState | undefined;
};

type ResolvedCallbackState =
  | {
      readonly ok: true;
      readonly identity: CallbackIdentity;
      readonly sessionId: string | undefined;
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
      readonly storedState: StoredOAuthState | undefined;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type ResolvedOAuthConnectorType =
  | {
      readonly ok: true;
      readonly connectorType: OAuthConnectorType;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

const connectorCallbackAuth = { requireOrganization: true } as const;

type ConnectorSessionTransitionInput = {
  readonly sessionId: string | undefined;
  readonly connectorType: OAuthConnectorType;
  readonly userId: string;
};

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return undefined;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [cookieName, ...rest] = cookie.trim().split("=");
    if (cookieName === name) {
      return decodeCookieComponent(rest.join("="));
    }
  }
  return undefined;
}

function getCallbackCookies(request: Request): CallbackCookies {
  return {
    savedState: getCookie(request, CONNECTOR_OAUTH_STATE_COOKIE_NAME),
    sessionId: getCookie(request, CONNECTOR_OAUTH_SESSION_COOKIE_NAME),
    codeVerifier: getCookie(request, CONNECTOR_OAUTH_PKCE_COOKIE_NAME),
    oauthContext: getCookie(request, CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME),
  };
}

function redirectWithError(
  origin: string,
  type: string,
  message: string,
  clearCookies = false,
): Response {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", type);
  errorUrl.searchParams.set("message", message);

  const response = redirectResponse(errorUrl.toString());
  if (clearCookies) {
    clearOAuthCookies(response);
  }
  return response;
}

function getProviderCredentialArgs(credentials: ConnectorOAuthCredentials): {
  readonly clientId?: string;
  readonly clientSecret?: string;
} {
  if (!isStaticConnectorOAuthCredentials(credentials)) {
    return {};
  }
  if (isStaticConfidentialConnectorOAuthCredentials(credentials)) {
    return {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    };
  }
  return { clientId: credentials.clientId };
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
  readonly connectorType: OAuthConnectorType;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  const provider = CONNECTOR_OAUTH_PROVIDERS[args.connectorType];
  const credentials = getConnectorOAuthCredentials(
    args.connectorType,
    optionalEnv,
  );
  if (!credentials?.configured) {
    throw new Error(`${args.connectorType} OAuth not configured`);
  }

  return await provider.exchangeCode({
    ...getProviderCredentialArgs(credentials),
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
}

function getRequestedScopes(
  connectorType: OAuthConnectorType,
): readonly string[] {
  return getOAuthConnectorConfig(connectorType).scopes;
}

function resolveOAuthConnectorType(
  origin: string,
  type: string,
): ResolvedOAuthConnectorType {
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return {
      ok: false,
      response: redirectWithError(origin, type, "Unknown connector type"),
    };
  }

  const connectorType = typeResult.data;
  if (connectorType === "computer") {
    return {
      ok: false,
      response: redirectWithError(
        origin,
        type,
        "Computer connector does not use OAuth",
      ),
    };
  }
  if (!isOAuthConnectorType(connectorType)) {
    return {
      ok: false,
      response: redirectWithError(
        origin,
        type,
        `${type} connector does not use OAuth`,
      ),
    };
  }

  return { ok: true, connectorType };
}

async function claimStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorType: OAuthConnectorType;
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

  return {
    ok: true,
    storedState:
      storedStateResolution.kind === "usable"
        ? storedStateResolution.state
        : undefined,
  };
}

async function rejectInvalidStoredOAuthStateForCallback(args: {
  readonly db: Db;
  readonly state: string;
  readonly connectorType: OAuthConnectorType;
  readonly origin: string;
  readonly type: string;
  readonly signal: AbortSignal;
}): Promise<Response | undefined> {
  const status = await getConnectorOAuthStateStatus(
    args.db,
    { state: args.state, connectorType: args.connectorType },
    args.signal,
  );
  if (status.kind !== "invalid") {
    return undefined;
  }

  return invalidStateRedirectResponse(args.origin, args.type);
}

async function hasPendingConnectorSession(
  db: Db,
  input: ConnectorSessionTransitionInput,
  signal: AbortSignal,
): Promise<boolean> {
  if (!input.sessionId) {
    return true;
  }
  const currentDate = nowDate();
  const [session] = await db
    .select({ id: connectorSessions.id })
    .from(connectorSessions)
    .where(
      and(
        eq(connectorSessions.id, input.sessionId),
        eq(connectorSessions.type, input.connectorType),
        eq(connectorSessions.userId, input.userId),
        eq(connectorSessions.status, "pending"),
        gt(connectorSessions.expiresAt, currentDate),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return Boolean(session);
}

async function markConnectorSessionError(
  db: Db,
  input: ConnectorSessionTransitionInput,
  errorMessage: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!input.sessionId) {
    return true;
  }
  const updatedAt = nowDate();
  const [updatedSession] = await db
    .update(connectorSessions)
    .set({
      status: "error",
      errorMessage,
    })
    .where(
      and(
        eq(connectorSessions.id, input.sessionId),
        eq(connectorSessions.type, input.connectorType),
        eq(connectorSessions.userId, input.userId),
        eq(connectorSessions.status, "pending"),
        gt(connectorSessions.expiresAt, updatedAt),
      ),
    )
    .returning({ id: connectorSessions.id });
  signal.throwIfAborted();
  return Boolean(updatedSession);
}

function successRedirectResponse(args: {
  readonly origin: string;
  readonly type: string;
  readonly username: string | null | undefined;
}): Response {
  const successUrl = new URL("/connector/success", args.origin);
  successUrl.searchParams.set("type", args.type);
  successUrl.searchParams.set("username", args.username ?? "");

  const response = redirectResponse(successUrl.toString());
  clearOAuthCookies(response);
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
    const writeDb = set(writeDb$);
    const session = {
      sessionId: args.sessionId,
      connectorType: args.connectorType,
      userId: args.identity.userId,
    };
    const hasValidSession = await hasPendingConnectorSession(
      writeDb,
      session,
      signal,
    );
    if (!hasValidSession) {
      return redirectWithError(
        args.origin,
        args.type,
        "Invalid session - please try again",
        true,
      );
    }

    const token = await exchangeTokenForConnector({
      connectorType: args.connectorType,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
    signal.throwIfAborted();

    const provider = CONNECTOR_OAUTH_PROVIDERS[args.connectorType];
    const connectorInput = {
      orgId: args.identity.orgId,
      userId: args.identity.userId,
      type: args.connectorType,
      accessToken: token.accessToken,
      userInfo: token.userInfo,
      oauthScopes: getRequestedScopes(args.connectorType),
      refreshToken: token.refreshToken,
      refreshSecretName: provider.getRefreshSecretName?.(),
      expiresIn: token.expiresIn,
    };
    const result = args.sessionId
      ? await set(
          completeOAuthConnectorSession$,
          {
            ...connectorInput,
            sessionId: args.sessionId,
          },
          signal,
        )
      : {
          status: "complete" as const,
          ...(await set(upsertOAuthConnector$, connectorInput, signal)),
        };
    signal.throwIfAborted();

    if (result.status === "invalid_session") {
      return redirectWithError(
        args.origin,
        args.type,
        "Invalid session - please try again",
        true,
      );
    }
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
    if (args.storedState) {
      return {
        ok: true,
        identity: {
          userId: args.storedState.userId,
          orgId: args.storedState.orgId,
        },
        sessionId: args.storedState.sessionId ?? undefined,
        codeVerifier: args.storedState.codeVerifier ?? undefined,
        oauthContext: args.storedState.oauthContext ?? undefined,
        redirectUri: args.storedState.redirectUri,
      };
    }

    const auth = await set(requiredAuthContext$, connectorCallbackAuth, signal);
    signal.throwIfAborted();
    if ("status" in auth) {
      return {
        ok: false,
        response: redirectWithError(
          args.origin,
          args.type,
          "Not authenticated",
        ),
      };
    }

    if (!auth.orgId) {
      return {
        ok: false,
        response: redirectWithError(
          args.origin,
          args.type,
          "Explicit org context required",
        ),
      };
    }

    if (args.state !== args.savedState) {
      return {
        ok: false,
        response: redirectWithError(
          args.origin,
          args.type,
          "Invalid state - please try again",
          true,
        ),
      };
    }
    const sessionId = parseConnectorOAuthSessionId(args.sessionId);
    if (sessionId === null) {
      return {
        ok: false,
        response: redirectWithError(
          args.origin,
          args.type,
          "Invalid session - please try again",
          true,
        ),
      };
    }

    return {
      ok: true,
      identity: {
        userId: auth.userId,
        orgId: auth.orgId,
      },
      sessionId,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
      redirectUri: `${args.origin}/api/connectors/${args.type}/callback`,
    };
  },
);

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(connectorsTypeCallbackContract.callback));
    const query = get(queryOf(connectorsTypeCallbackContract.callback));
    const request = get(request$).raw;
    const canonicalRedirectUrl = getConnectorOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return redirectResponse(canonicalRedirectUrl);
    }
    const origin = getConnectorOAuthOrigin(request);

    const connectorTypeResult = resolveOAuthConnectorType(origin, params.type);
    if (!connectorTypeResult.ok) {
      return connectorTypeResult.response;
    }
    const { connectorType } = connectorTypeResult;

    const writeDb = set(writeDb$);
    const callbackCookies = getCallbackCookies(request);
    const state = query.state;
    const storedStateValue =
      callbackCookies.savedState === state ? undefined : state;
    const storedStateCallbackArgs = {
      db: writeDb,
      connectorType,
      origin,
      type: params.type,
      signal,
    };

    if (query.error) {
      if (storedStateValue) {
        const claimedState = await claimStoredOAuthStateForCallback({
          ...storedStateCallbackArgs,
          state: storedStateValue,
        });
        signal.throwIfAborted();
        if (!claimedState.ok) {
          return claimedState.response;
        }
      }
      return redirectWithError(
        origin,
        params.type,
        query.error_description || query.error || "OAuth authorization failed",
        true,
      );
    }

    const code = query.code;
    if (!code) {
      if (storedStateValue) {
        const invalidStateResponse =
          await rejectInvalidStoredOAuthStateForCallback({
            ...storedStateCallbackArgs,
            state: storedStateValue,
          });
        signal.throwIfAborted();
        if (invalidStateResponse) {
          return invalidStateResponse;
        }
      }
      return missingAuthorizationCodeRedirectResponse(origin, params.type);
    }

    if (!state) {
      return missingStateRedirectResponse(origin, params.type);
    }

    let claimedState: ClaimedCallbackState = {
      ok: true,
      storedState: undefined,
    };
    if (storedStateValue) {
      claimedState = await claimStoredOAuthStateForCallback({
        ...storedStateCallbackArgs,
        state: storedStateValue,
      });
      signal.throwIfAborted();
    }
    if (!claimedState.ok) {
      return claimedState.response;
    }

    const resolvedState = await set(
      resolveCallbackState$,
      {
        origin,
        type: params.type,
        savedState: callbackCookies.savedState,
        state,
        sessionId: callbackCookies.sessionId,
        codeVerifier: callbackCookies.codeVerifier,
        oauthContext: callbackCookies.oauthContext,
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
          code,
          redirectUri: resolvedState.redirectUri,
          state,
          codeVerifier: resolvedState.codeVerifier,
          oauthContext: resolvedState.oauthContext,
          identity: resolvedState.identity,
          sessionId: resolvedState.sessionId,
          origin,
          type: params.type,
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
      {
        sessionId: resolvedState.sessionId,
        connectorType,
        userId: resolvedState.identity.userId,
      },
      errorMessageFromUnknown(callbackResult.error),
      signal,
    );
    return redirectWithError(
      origin,
      params.type,
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
