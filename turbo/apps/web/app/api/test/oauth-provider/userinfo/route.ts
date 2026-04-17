import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import {
  isTestOAuthAccessToken,
  isTestOAuthAccessTokenExpired,
} from "../_lib/token-helpers";

/**
 * GET /api/test/oauth-provider/userinfo
 *
 * Fake OAuth 2.0 userinfo endpoint. Requires a Bearer token minted by the
 * fake token endpoint. Returns a deterministic user payload.
 *
 * Validates the token's embedded expiry — tokens past their baked-in
 * timestamp return 401, mirroring real providers.
 */
export function GET(request: Request): Response {
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
    id: "testoauth-user-1",
    username: "testoauth",
    email: "testoauth@example.com",
  });
}
