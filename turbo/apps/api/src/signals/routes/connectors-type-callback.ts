import { command } from "ccstate";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import {
  getConnectorOAuthConfig,
  getConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  exchangeProviderCode,
  PROVIDER_HANDLERS,
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
import { upsertOAuthConnector$ } from "../services/zero-connector-data.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route";

const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const PKCE_COOKIE_NAME = "connector_oauth_pkce";
const OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
const REDIRECT_STATUS = 307;

type OAuthConnectorType = Exclude<ConnectorType, "computer">;

function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return undefined;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [cookieName, ...rest] = cookie.trim().split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }
  return url.origin;
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

async function exchangeTokenForConnector(args: {
  readonly connectorType: OAuthConnectorType;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  const handler = PROVIDER_HANDLERS[args.connectorType];
  const credentials = getConnectorOAuthCredentials(
    args.connectorType,
    optionalEnv,
  );
  if (!credentials?.configured) {
    throw new Error(`${args.connectorType} OAuth not configured`);
  }

  return await exchangeProviderCode(handler, {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
}

function getRequestedScopes(connectorType: ConnectorType): readonly string[] {
  return getConnectorOAuthConfig(connectorType)?.scopes ?? [];
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

const callbackConnectorInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(connectorsTypeCallbackContract.callback));
    const query = get(queryOf(connectorsTypeCallbackContract.callback));
    const request = get(request$).raw;
    const origin = getRequestOrigin(request);

    const typeResult = connectorTypeSchema.safeParse(params.type);
    if (!typeResult.success) {
      return redirectWithError(origin, params.type, "Unknown connector type");
    }
    const connectorType = typeResult.data;

    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      return redirectWithError(origin, params.type, "Not authenticated");
    }

    if (connectorType === "computer") {
      return redirectWithError(
        origin,
        params.type,
        "Computer connector does not use OAuth",
      );
    }

    if (!auth.orgId) {
      return redirectWithError(
        origin,
        params.type,
        "Explicit org context required",
      );
    }

    const savedState = getCookie(request, STATE_COOKIE_NAME);
    const sessionId = getCookie(request, SESSION_COOKIE_NAME);
    const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);
    const oauthContext = getCookie(request, OAUTH_CONTEXT_COOKIE_NAME);

    if (query.error) {
      return redirectWithError(
        origin,
        params.type,
        query.error_description || query.error || "OAuth authorization failed",
        true,
      );
    }

    const code = query.code;
    if (!code) {
      return redirectWithError(
        origin,
        params.type,
        "Missing authorization code",
        true,
      );
    }

    const state = query.state;
    if (!state) {
      return redirectWithError(
        origin,
        params.type,
        "Missing state parameter",
        true,
      );
    }

    if (state !== savedState) {
      return redirectWithError(
        origin,
        params.type,
        "Invalid state - please try again",
        true,
      );
    }

    const writeDb = set(writeDb$);
    const callbackResult = await settle(
      (async (): Promise<Response> => {
        const redirectUri = `${origin}/api/connectors/${params.type}/callback`;
        const token = await exchangeTokenForConnector({
          connectorType,
          code,
          redirectUri,
          state,
          codeVerifier,
          oauthContext,
        });
        signal.throwIfAborted();

        const handler = PROVIDER_HANDLERS[connectorType];
        const result = await set(
          upsertOAuthConnector$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            type: connectorType,
            accessToken: token.accessToken,
            userInfo: token.userInfo,
            oauthScopes: getRequestedScopes(connectorType),
            refreshToken: token.refreshToken,
            refreshSecretName: handler.getRefreshSecretName?.(),
            expiresIn: token.expiresIn,
          },
          signal,
        );
        signal.throwIfAborted();

        await completeConnectorSession(writeDb, sessionId, signal);
        return successRedirectResponse({
          origin,
          type: params.type,
          username: result.connector.externalUsername,
        });
      })(),
    );
    signal.throwIfAborted();

    if (callbackResult.ok) {
      return callbackResult.value;
    }

    await markConnectorSessionError(
      writeDb,
      sessionId,
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
