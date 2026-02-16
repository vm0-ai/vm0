import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import { connectorSessions } from "../../../../../src/db/schema/connector-session";
import { logger } from "../../../../../src/lib/logger";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { getPlatform } from "../../../../../src/lib/connector/platform/router";
import { getUserScopeByClerkId } from "../../../../../src/lib/scope/scope-service";

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

  // Computer connector does not use OAuth
  if (connectorType === "computer") {
    return redirectWithError(
      origin,
      type,
      "Computer connector does not use OAuth",
    );
  }

  // Get user scope for building connection ID
  const scope = await getUserScopeByClerkId(userId);
  if (!scope) {
    return redirectWithError(origin, type, "User scope not found");
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

    // Build connection ID for platform abstraction
    const connectionId = `${scope.id}:${connectorType}`;

    // Use platform abstraction to handle OAuth callback
    const platform = getPlatform(connectorType);
    const result = await platform.handleCallback({
      type: connectorType,
      code,
      state,
      connectionId,
      redirectUri,
    });

    log.debug("Storing connector", {
      userId,
      type,
      username: result.externalUsername,
    });

    // Store connector and secret
    // For self-hosted platforms, accessToken is provided in result
    // For Nango platforms, accessToken is managed by Nango (not in result)
    const { created } = await upsertOAuthConnector(
      userId,
      connectorType,
      result.accessToken ?? "", // Empty string for Nango-managed connectors
      {
        id: result.externalId,
        username: result.externalUsername ?? "",
        email: result.externalEmail,
      },
      result.oauthScopes ?? [],
    );

    log.info("Connector OAuth completed", {
      type,
      username: result.externalUsername,
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
    successUrl.searchParams.set("username", result.externalUsername ?? "");

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
