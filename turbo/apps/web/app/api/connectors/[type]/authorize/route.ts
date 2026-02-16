import { NextResponse } from "next/server";
import { connectorTypeSchema } from "@vm0/core";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { getPlatform } from "../../../../../src/lib/connector/platform/router";
import { getUserScopeByClerkId } from "../../../../../src/lib/scope/scope-service";

/**
 * Connector OAuth Authorize Endpoint
 *
 * GET /api/connectors/:type/authorize
 *
 * Redirects users to the OAuth provider's authorization page
 */

// Cookie names for OAuth state and session
const STATE_COOKIE_NAME = "connector_oauth_state";
const SESSION_COOKIE_NAME = "connector_oauth_session";
const COOKIE_MAX_AGE = 15 * 60; // 15 minutes

/**
 * Generate a random state string for CSRF protection
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build Set-Cookie header value
 */
function buildCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env().NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  initServices();

  const { type } = await params;

  // Validate connector type
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return NextResponse.json(
      { error: `Unknown connector type: ${type}` },
      { status: 400 },
    );
  }
  const connectorType = typeResult.data;

  // Resolve origin early (handles forwarded host behind proxy/tunnel)
  const url = new URL(request.url);
  const origin = getOrigin(request);

  // Verify user is authenticated
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    // Redirect to login page using correct origin (not localhost behind tunnel)
    const loginUrl = new URL("/sign-in", origin);
    const authorizeUrl = new URL(url.pathname + url.search, origin);
    loginUrl.searchParams.set("redirect_url", authorizeUrl.toString());
    return NextResponse.redirect(loginUrl.toString());
  }

  // Computer connector does not use OAuth
  if (connectorType === "computer") {
    return NextResponse.json(
      { error: "Computer connector does not use OAuth" },
      { status: 400 },
    );
  }

  // Get user scope for building connection ID
  const scope = await getUserScopeByClerkId(userId);
  if (!scope) {
    return NextResponse.json(
      { error: "User scope not found" },
      { status: 500 },
    );
  }

  // Generate state for CSRF protection
  const state = generateState();

  // Build redirect URI
  const redirectUri = `${origin}/api/connectors/${type}/callback`;

  // Check for session parameter (CLI device flow)
  const sessionId = url.searchParams.get("session");

  // Build connection ID for platform abstraction
  const connectionId = `${scope.id}:${connectorType}`;

  // Use platform abstraction to build authorization URL
  const platform = getPlatform(connectorType);
  const authUrl = await platform.buildAuthorizationUrl({
    type: connectorType,
    connectionId,
    redirectUri,
    state,
  });

  // Create redirect response with state cookie
  const response = NextResponse.redirect(authUrl);
  response.headers.append(
    "Set-Cookie",
    buildCookieHeader(STATE_COOKIE_NAME, state, COOKIE_MAX_AGE),
  );

  // If session ID provided, store it in a cookie for the callback
  if (sessionId) {
    response.headers.append(
      "Set-Cookie",
      buildCookieHeader(SESSION_COOKIE_NAME, sessionId, COOKIE_MAX_AGE),
    );
  }

  return response;
}
