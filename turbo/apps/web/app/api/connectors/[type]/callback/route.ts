import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  type ConnectorType,
  connectorTypeSchema,
} from "@vm0/connectors/connectors";
import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { upsertOAuthConnector } from "../../../../../src/lib/zero/connector/connector-service";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { logger } from "../../../../../src/lib/shared/logger";
import { getOrigin } from "../../../../../src/lib/shared/request/get-origin";
import {
  PROVIDER_HANDLERS,
  type OAuthTokenResult,
} from "../../../../../src/lib/zero/connector/provider-registry";

const log = logger("api:connectors:callback");

/**
 * Connector OAuth Callback Endpoint
 *
 * GET /api/connectors/:type/callback
 *
 * Handles OAuth callback from provider, exchanges code for token,
 * stores connector and redirects to success page
 */

// Cookie names for OAuth state, session, and PKCE
const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const PKCE_COOKIE_NAME = "connector_oauth_pkce";

/**
 * Parse cookies from request header
 */
function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(";").map((c) => {
    return c.trim();
  });
  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

/**
 * Build Set-Cookie header to delete a cookie
 */
function buildDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

async function exchangeTokenForConnector(
  connectorType: keyof typeof PROVIDER_HANDLERS,
  code: string,
  redirectUri: string,
  state?: string,
  codeVerifier?: string,
): Promise<OAuthTokenResult> {
  const currentEnv = env();
  const handler = PROVIDER_HANDLERS[connectorType];
  const clientId = handler.getClientId(currentEnv);
  const clientSecret = handler.getClientSecret(currentEnv);
  if (!clientId || !clientSecret) {
    throw new Error(`${connectorType} OAuth not configured`);
  }
  return handler.exchangeCode(
    clientId,
    clientSecret,
    code,
    redirectUri,
    state,
    codeVerifier,
  );
}

/**
 * Get the scopes we *request* from the OAuth provider (from our config).
 * We store these instead of provider-granted scopes so that
 * hasRequiredScopes() can reliably detect when code adds new scopes.
 */
function getRequestedScopes(connectorType: ConnectorType): string[] {
  return getConnectorOAuthConfig(connectorType)?.scopes ?? [];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  initServices();

  const { type } = await params;
  const url = new URL(request.url);
  const origin = getOrigin(request);

  // Validate connector type using Zod schema for runtime type safety
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return redirectWithError(origin, type, "Unknown connector type");
  }
  const connectorType = typeResult.data;

  // Verify user is authenticated
  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader);
  log.debug("OAuth callback auth check", { hasAuth: !!authCtx });
  if (!authCtx) {
    return redirectWithError(origin, type, "Not authenticated");
  }

  // Computer connector does not use OAuth
  if (connectorType === "computer") {
    return redirectWithError(
      origin,
      type,
      "Computer connector does not use OAuth",
    );
  }

  // Get state, session, and PKCE code_verifier from cookies
  const savedState = getCookie(request, STATE_COOKIE_NAME);
  const sessionId = getCookie(request, SESSION_COOKIE_NAME);
  const codeVerifier = getCookie(request, PKCE_COOKIE_NAME);

  // Get code and state from query params
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Handle OAuth error from provider
  if (error) {
    log.warn("OAuth error from provider", { error, errorDescription });
    return redirectWithError(
      origin,
      type,
      errorDescription || error || "OAuth authorization failed",
      true,
    );
  }

  // Validate required params
  if (!code) {
    return redirectWithError(origin, type, "Missing authorization code", true);
  }

  if (!state) {
    return redirectWithError(origin, type, "Missing state parameter", true);
  }

  // Validate state matches
  if (state !== savedState) {
    log.warn("State mismatch", { expected: savedState, received: state });
    return redirectWithError(
      origin,
      type,
      "Invalid state - please try again",
      true,
    );
  }

  try {
    // Build redirect URI (must match authorize endpoint)
    const redirectUri = `${origin}/api/connectors/${type}/callback`;

    // Exchange code for token directly from provider
    const { accessToken, refreshToken, expiresIn, userInfo } =
      await exchangeTokenForConnector(
        connectorType,
        code,
        redirectUri,
        state ?? undefined,
        codeVerifier,
      );

    const { userId } = authCtx;

    log.debug("Storing connector", {
      userId,
      type,
      username: userInfo.username,
    });

    // Build refresh token options if provider supports it
    const handler = PROVIDER_HANDLERS[connectorType];
    const refreshSecretName = handler.getRefreshSecretName?.();

    // Store the *requested* scopes (from our config), not the provider-granted
    // scopes. Providers may return different scope names than requested (e.g.
    // GitHub deduplicates implied scopes, Salesforce omits scopes entirely).
    // By storing what we requested, hasRequiredScopes() can reliably detect
    // when the code adds new scopes and prompt users to re-authorize.
    // Note: do not read "scope" from the callback URL — OAuth providers (e.g., Monday.com)
    // may append OAuth scopes as ?scope=... which would be mistaken for an app scope slug.
    const { org } = await resolveOrg(authCtx);
    const { created } = await upsertOAuthConnector(
      org.orgId,
      userId,
      connectorType,
      accessToken,
      {
        id: userInfo.id,
        username: userInfo.username ?? "",
        email: userInfo.email,
      },
      getRequestedScopes(connectorType),
      { refreshToken, refreshSecretName, expiresIn },
    );

    log.info("Connector OAuth completed", {
      type,
      username: userInfo.username,
      created,
      sessionId,
    });

    // If this was a CLI session, mark it as complete
    if (sessionId) {
      await globalThis.services.db
        .update(connectorSessions)
        .set({
          status: "complete",
          completedAt: new Date(),
        })
        .where(eq(connectorSessions.id, sessionId));

      log.debug("Connector session marked complete", { sessionId });
    }

    // Redirect to success page
    const successUrl = new URL("/connector/success", origin);
    successUrl.searchParams.set("type", type);
    successUrl.searchParams.set("username", userInfo.username ?? "");

    const response = NextResponse.redirect(successUrl.toString());
    // Clear cookies
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
    return response;
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : "OAuth failed";
    log.error("OAuth callback error", {
      type,
      error: internalMessage,
      sessionId,
    });

    // Mark session as error if present (store full error server-side only)
    if (sessionId) {
      await globalThis.services.db
        .update(connectorSessions)
        .set({
          status: "error",
          errorMessage: internalMessage,
        })
        .where(eq(connectorSessions.id, sessionId));
    }

    return redirectWithError(
      origin,
      type,
      "OAuth authorization failed. Please try again.",
      true,
    );
  }
}

/**
 * Helper to redirect with error
 */
function redirectWithError(
  origin: string,
  type: string,
  message: string,
  clearCookies = false,
): NextResponse {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", type);
  errorUrl.searchParams.set("message", message);

  const response = NextResponse.redirect(errorUrl.toString());
  if (clearCookies) {
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
  }
  return response;
}
