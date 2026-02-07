import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { buildGitHubAuthorizationUrl } from "../../../../../src/lib/connector/providers/github";
import { getOrigin } from "../../../../../src/lib/request/get-origin";

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
  if (process.env.NODE_ENV === "production") {
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
  if (type !== "github") {
    return NextResponse.json(
      { error: `Unknown connector type: ${type}` },
      { status: 400 },
    );
  }

  // Verify user is authenticated
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    // Redirect to login page
    const url = new URL(request.url);
    const loginUrl = new URL("/sign-in", url.origin);
    loginUrl.searchParams.set("redirect_url", request.url);
    return NextResponse.redirect(loginUrl.toString());
  }

  const env = globalThis.services.env;

  // Check if GitHub OAuth is configured
  if (!env.GH_OAUTH_CLIENT_ID || !env.GH_OAUTH_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured" },
      { status: 503 },
    );
  }

  // Generate state for CSRF protection
  const state = generateState();

  // Build redirect URI (use forwarded host if behind proxy/tunnel)
  const url = new URL(request.url);
  const origin = getOrigin(request);
  const redirectUri = `${origin}/api/connectors/${type}/callback`;

  // Check for session parameter (CLI device flow)
  const sessionId = url.searchParams.get("session");

  // Build authorization URL
  const authUrl = buildGitHubAuthorizationUrl(
    env.GH_OAUTH_CLIENT_ID,
    redirectUri,
    state,
  );

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
