import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import {
  isTestOAuthAccessToken,
  isTestOAuthAccessTokenExpired,
} from "../_lib/token-helpers";

/**
 * GET /api/test/oauth-provider/echo
 *
 * Fake "protected upstream" API for E2E tests. The firewall rule for the
 * test-oauth connector points here, so when an agent calls this URL the
 * mitm-addon injects the Authorization header from the connector's stored
 * access token. Validates the injected token's baked-in expiry and returns
 * 401 if stale — so a broken refresh pipeline surfaces as a non-200 in E2E.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token || !isTestOAuthAccessToken(token)) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }
  if (isTestOAuthAccessTokenExpired(token)) {
    return NextResponse.json({ error: "expired_token" }, { status: 401 });
  }

  return NextResponse.json({
    authorization,
    receivedAt: new Date().toISOString(),
  });
}
