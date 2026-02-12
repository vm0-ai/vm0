import { NextResponse } from "next/server";
import { connectorTypeSchema } from "@vm0/core";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { buildGitHubAuthorizationUrl } from "../../../../../src/lib/connector/providers/github";
import { buildNotionAuthorizationUrl } from "../../../../../src/lib/connector/providers/notion";
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

  const env = globalThis.services.env;

  // Get OAuth credentials for connector type
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  switch (connectorType) {
    case "github":
      clientId = env.GH_OAUTH_CLIENT_ID;
      clientSecret = env.GH_OAUTH_CLIENT_SECRET;
      break;
    case "notion":
      clientId = env.NOTION_OAUTH_CLIENT_ID;
      clientSecret = env.NOTION_OAUTH_CLIENT_SECRET;
      break;
  }

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: `${connectorType} OAuth is not configured` },
      { status: 503 },
    );
  }

  // Generate state for CSRF protection
  const state = generateState();

  // Build redirect URI
  const redirectUri = `${origin}/api/connectors/${type}/callback`;

  // Check for session parameter (CLI device flow)
  const sessionId = url.searchParams.get("session");

  // Build authorization URL for connector type
  let authUrl: string;

  switch (connectorType) {
    case "github":
      authUrl = buildGitHubAuthorizationUrl(clientId, redirectUri, state);
      break;
    case "notion":
      authUrl = buildNotionAuthorizationUrl(clientId, redirectUri, state);
      break;
  }

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
