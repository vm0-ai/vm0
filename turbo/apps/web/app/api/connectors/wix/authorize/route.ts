import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { buildWixAuthorizationUrl } from "../../../../../src/lib/connector/providers/wix";

/**
 * Wix Connector Authorization Endpoint
 *
 * GET /api/connectors/wix/authorize
 *
 * Redirects users to the Wix installer page. After installing the app,
 * Wix opens the Dashboard Page extension (iFrame) where the user
 * completes the VM0 connection via /connector/wix.
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

  const authUrl = buildWixAuthorizationUrl(clientId);
  return NextResponse.redirect(authUrl);
}
