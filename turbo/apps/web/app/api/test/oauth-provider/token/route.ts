import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import {
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
} from "@vm0/connectors/oauth-providers/providers/test-oauth-constants";
import {
  isTestOAuthRefreshToken,
  mintAccessToken,
  mintRefreshToken,
  parseScenarioFromCode,
  parseScenarioFromRefreshToken,
  type TestOAuthScenario,
} from "../_lib/token-helpers";

const DEFAULT_EXPIRES_IN = 3600;

interface TokenSuccess {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

function mintTokensForScenario(scenario: TestOAuthScenario): TokenSuccess {
  const expiresIn = scenario === "expired-access" ? 0 : DEFAULT_EXPIRES_IN;
  return {
    access_token: mintAccessToken(expiresIn),
    refresh_token: mintRefreshToken(scenario),
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "read",
  };
}

async function parseFormBody(
  request: Request,
): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return null;
  }
  const text = await request.text();
  return new URLSearchParams(text);
}

function handleAuthorizationCode(code: string | null): Response {
  if (!code) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "code required" },
      { status: 400 },
    );
  }
  const scenario = parseScenarioFromCode(code);
  if (!scenario) {
    return NextResponse.json(
      {
        error: "invalid_grant",
        error_description: "malformed or unknown code",
      },
      { status: 400 },
    );
  }
  if (scenario === "revoked") {
    return NextResponse.json(
      { error: "invalid_grant", error_description: "token revoked" },
      { status: 401 },
    );
  }
  return NextResponse.json(mintTokensForScenario(scenario));
}

function handleRefreshToken(refreshToken: string | null): Response {
  if (!refreshToken) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "refresh_token required",
      },
      { status: 400 },
    );
  }
  // Refresh token handling tiers:
  //  1. testoauth_rt_* but scenario segment is unknown → reject as malformed.
  //     Without this a typo ("revokes" instead of "revoked") would silently
  //     fall through to "success" and mask the test scenario the author meant.
  //  2. testoauth_rt_<scenario>_* with one of the rejection scenarios → 400.
  //  3. No prefix at all (not one of ours) → accept-as-success. Real OAuth
  //     providers don't force callers to carry structure; we preserve that
  //     tolerance so tests seeding arbitrary refresh tokens still succeed.
  const scenario = parseScenarioFromRefreshToken(refreshToken);
  if (!scenario && isTestOAuthRefreshToken(refreshToken)) {
    return NextResponse.json(
      {
        error: "invalid_grant",
        error_description: "malformed or unknown refresh token scenario",
      },
      { status: 400 },
    );
  }
  const resolved: TestOAuthScenario = scenario ?? "success";
  if (resolved === "invalid-refresh" || resolved === "revoked") {
    return NextResponse.json(
      { error: "invalid_grant", error_description: "refresh token rejected" },
      { status: 400 },
    );
  }
  return NextResponse.json(mintTokensForScenario(resolved));
}

/**
 * POST /api/test/oauth-provider/token
 *
 * Fake OAuth 2.0 token endpoint. Supports authorization_code and
 * refresh_token grants. Behavior (success / expired-access / invalid-refresh
 * / revoked) is encoded into the code/refresh_token itself by the authorize
 * endpoint, making this route stateless — safe for Vercel serverless
 * instances that don't share memory.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = await parseFormBody(request);
  if (!body) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "expected form body" },
      { status: 400 },
    );
  }

  const grantType = body.get("grant_type");
  const clientId = body.get("client_id");
  const clientSecret = body.get("client_secret");

  if (
    clientId !== TEST_OAUTH_CLIENT_ID ||
    clientSecret !== TEST_OAUTH_CLIENT_SECRET
  ) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(body.get("code"));
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(body.get("refresh_token"));
  }

  return NextResponse.json(
    { error: "unsupported_grant_type" },
    { status: 400 },
  );
}
