import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import {
  exchangeGitHubCode,
  fetchGitHubUserInfo,
} from "../../../../../src/lib/connector/providers/github";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import { connectorSessions } from "../../../../../src/db/schema/connector-session";
import { logger } from "../../../../../src/lib/logger";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { connectorTypeSchema } from "@vm0/core";

const log = logger("api:connectors:callback");

/**
 * Connector OAuth Callback Endpoint
 *
 * GET /api/connectors/:type/callback
 *
 * Handles OAuth callback from provider, exchanges code for token,
 * stores connector and redirects to success page
 */

// Cookie names for OAuth state and session
const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";

/**
 * Parse cookies from request header
 */
function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
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
  const userId = await getUserIdFromRequest(request);
  log.debug("OAuth callback auth check", { userId, hasUserId: !!userId });
  if (!userId) {
    return redirectWithError(origin, type, "Not authenticated");
  }

  const env = globalThis.services.env;

  // Check if GitHub OAuth is configured
  if (!env.GH_OAUTH_CLIENT_ID || !env.GH_OAUTH_CLIENT_SECRET) {
    return redirectWithError(origin, type, "GitHub OAuth not configured");
  }

  // Get state and session from cookies
  const savedState = getCookie(request, STATE_COOKIE_NAME);
  const sessionId = getCookie(request, SESSION_COOKIE_NAME);

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

    // Exchange code for token
    const { accessToken, scopes } = await exchangeGitHubCode(
      env.GH_OAUTH_CLIENT_ID,
      env.GH_OAUTH_CLIENT_SECRET,
      code,
      redirectUri,
    );

    // Fetch user info
    const userInfo = await fetchGitHubUserInfo(accessToken);

    log.debug("Storing connector", {
      userId,
      type,
      username: userInfo.username,
    });

    // Store connector and secret
    const { created } = await upsertOAuthConnector(
      userId,
      connectorType,
      accessToken,
      userInfo,
      scopes,
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
    successUrl.searchParams.set("username", userInfo.username);

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
    return response;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "OAuth failed";
    log.error("OAuth callback error", {
      type,
      error: errorMessage,
      sessionId,
    });

    // Mark session as error if present
    if (sessionId) {
      await globalThis.services.db
        .update(connectorSessions)
        .set({
          status: "error",
          errorMessage,
        })
        .where(eq(connectorSessions.id, sessionId));
    }

    return redirectWithError(origin, type, errorMessage, true);
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
  }
  return response;
}
