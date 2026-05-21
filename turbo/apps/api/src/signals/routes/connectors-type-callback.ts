import { unescape as decodeCookieComponent } from "node:querystring";

import { command } from "ccstate";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  getConnectorOAuthCredentials,
  getOAuthConnectorConfig,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type OAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  exchangeConnectorOAuthCode,
  isOAuthConnectorType,
  CONNECTOR_OAUTH_PROVIDERS,
  type OAuthTokenResult,
} from "@vm0/connectors/oauth-providers";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { eq } from "drizzle-orm";

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
import { upsertOAuthConnector$ } from "../services/zero-connector-data.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route";
import {
  getConnectorOAuthCanonicalRedirectUrl,
  getConnectorOAuthOrigin,
} from "./connector-oauth-origin";

const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const PKCE_COOKIE_NAME = "connector_oauth_pkce";
const OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
const REDIRECT_STATUS = 307;

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

function buildDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function clearOAuthCookies(response: Response): void {
  response.headers.append(
    "Set-Cookie",
    buildDeleteCookieHeader(STATE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteCookieHeader(SESSION_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteCookieHeader(PKCE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteCookieHeader(OAUTH_CONTEXT_COOKIE_NAME),
  );
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
  const credentials = getConnectorOAuthCredentials(
    args.connectorType,
    optionalEnv,
  );
  if (!credentials?.configured) {
    throw new Error(`${args.connectorType} OAuth not configured`);
  }

  return await exchangeConnectorOAuthCode({
    type: args.connectorType,
    credentials,
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
    const result = await set(
      upsertOAuthConnector$,
      {
        orgId: args.identity.orgId,
        userId: args.identity.userId,
        type: args.connectorType,
        accessToken: token.accessToken,
        userInfo: token.userInfo,
        oauthScopes: getRequestedScopes(args.connectorType),
        refreshToken: token.refreshToken,
        refreshSecretName: provider.getRefreshSecretName?.(),
        expiresIn: token.expiresIn,
      },
      signal,
    );
    signal.throwIfAborted();

    await completeConnectorSession(set(writeDb$), args.sessionId, signal);
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

    return {
      ok: true,
      identity: {
        userId: auth.userId,
        orgId: auth.orgId,
      },
      sessionId: args.sessionId,
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
    const savedState = getCookie(request, STATE_COOKIE_NAME);
    const sessionId = getCookie(request, SESSION_COOKIE_NAME);
    const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);
    const oauthContext = getCookie(request, OAUTH_CONTEXT_COOKIE_NAME);
    const state = query.state;
    const storedStateCallbackArgs = {
      db: writeDb,
      connectorType,
      origin,
      type: params.type,
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
        params.type,
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
      return missingAuthorizationCodeRedirectResponse(origin, params.type);
    }

    if (!state) {
      return missingStateRedirectResponse(origin, params.type);
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
        type: params.type,
        savedState,
        state,
        sessionId,
        codeVerifier,
        oauthContext,
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
      resolvedState.sessionId,
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
