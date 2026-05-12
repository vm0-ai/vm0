import { command } from "ccstate";
import {
  testOAuthProviderTokenContract,
  type TestOAuthProviderTokenResponse,
} from "@vm0/api-contracts/contracts/test-oauth-provider-token";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  isTestOAuthRefreshToken,
  mintAccessToken,
  mintRefreshToken,
  parseScenarioFromCode,
  parseScenarioFromRefreshToken,
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  testEndpointNotFoundResponse,
  type TestOAuthScenario,
} from "./test-oauth-provider-helpers";

const DEFAULT_EXPIRES_IN = 3600;

function mintTokensForScenario(
  scenario: TestOAuthScenario,
): TestOAuthProviderTokenResponse {
  const expiresIn = scenario === "expired-access" ? 0 : DEFAULT_EXPIRES_IN;
  return {
    access_token: mintAccessToken(expiresIn),
    refresh_token: mintRefreshToken(scenario),
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "read",
  };
}

function errorResponse(
  status: 400 | 401,
  error: string,
  errorDescription?: string,
) {
  return {
    status,
    body: errorDescription
      ? { error, error_description: errorDescription }
      : { error },
  };
}

function handleAuthorizationCode(code: string | null) {
  if (!code) {
    return errorResponse(400, "invalid_request", "code required");
  }

  const scenario = parseScenarioFromCode(code);
  if (!scenario) {
    return errorResponse(400, "invalid_grant", "malformed or unknown code");
  }

  if (scenario === "revoked") {
    return errorResponse(401, "invalid_grant", "token revoked");
  }

  return { status: 200 as const, body: mintTokensForScenario(scenario) };
}

function handleRefreshToken(refreshToken: string | null) {
  if (!refreshToken) {
    return errorResponse(400, "invalid_request", "refresh_token required");
  }

  const scenario = parseScenarioFromRefreshToken(refreshToken);
  if (!scenario && isTestOAuthRefreshToken(refreshToken)) {
    return errorResponse(
      400,
      "invalid_grant",
      "malformed or unknown refresh token scenario",
    );
  }

  const resolved = scenario ?? "success";
  if (resolved === "invalid-refresh" || resolved === "revoked") {
    return errorResponse(400, "invalid_grant", "refresh token rejected");
  }

  return { status: 200 as const, body: mintTokensForScenario(resolved) };
}

const token$ = command(async ({ get }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const contentType = request.header("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return errorResponse(400, "invalid_request", "expected form body");
  }

  const text = await request.text();
  signal.throwIfAborted();

  const body = new URLSearchParams(text);
  const grantType = body.get("grant_type");
  const clientId = body.get("client_id");
  const clientSecret = body.get("client_secret");

  if (
    clientId !== TEST_OAUTH_CLIENT_ID ||
    clientSecret !== TEST_OAUTH_CLIENT_SECRET
  ) {
    return errorResponse(401, "invalid_client");
  }

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(body.get("code"));
  }

  if (grantType === "refresh_token") {
    return handleRefreshToken(body.get("refresh_token"));
  }

  return errorResponse(400, "unsupported_grant_type");
});

export const testOAuthProviderTokenRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderTokenContract.token,
    handler: token$,
  },
];
