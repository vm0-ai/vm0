import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { buildWixAuthorizationUrl } from "../../../../../src/lib/connector/providers/wix";

const STATE_COOKIE_NAME = "connector_oauth_state";
const COOKIE_MAX_AGE = 15 * 60; // 15 minutes

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wix Connector Authorization Endpoint
 *
 * GET /api/connectors/wix/authorize
 *
 * Redirects users to the Wix installer page. After installing the app,
 * Wix redirects back to /api/connectors/wix/complete with the instanceId.
 */
export async function GET(request: Request) {
  initServices();

  const currentEnv = env();
  const origin = getOrigin(request);
  const url = new URL(request.url);

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    const loginUrl = new URL("/sign-in", origin);
    loginUrl.searchParams.set(
      "redirect_url",
      new URL(url.pathname + url.search, origin).toString(),
    );
    return NextResponse.redirect(loginUrl.toString());
  }

  const clientId = currentEnv.WIX_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Wix OAuth not configured" },
      { status: 500 },
    );
  }

  const state = generateState();
  const redirectUri = `${origin}/api/connectors/wix/complete`;
  const authUrl = buildWixAuthorizationUrl(clientId, redirectUri, state);

  const response = NextResponse.redirect(authUrl);
  const cookieParts = [
    `${STATE_COOKIE_NAME}=${state}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (currentEnv.NODE_ENV === "production") {
    cookieParts.push("Secure");
  }
  response.headers.set("Set-Cookie", cookieParts.join("; "));

  return response;
}
