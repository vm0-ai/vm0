import { command } from "ccstate";
import {
  testOAuthProviderTokenContract,
  type TestOAuthProviderTokenResponse,
} from "@vm0/api-contracts/contracts/test-oauth-provider-token";

import { env } from "../../lib/env";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  isTestOAuthDeviceClientId,
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
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SHORT_LIVED_EXPIRES_IN = 55;

function mintTokensForScenario(
  scenario: TestOAuthScenario,
): TestOAuthProviderTokenResponse {
  const expiresIn =
    scenario === "expired-access"
      ? 0
      : scenario === "short-lived-access"
        ? SHORT_LIVED_EXPIRES_IN
        : DEFAULT_EXPIRES_IN;
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

function deviceGrantErrorForDeviceCode(
  deviceCode: string,
): ReturnType<typeof errorResponse> | null {
  if (deviceCode === "pending") {
    return errorResponse(400, "authorization_pending");
  }
  if (deviceCode === "slow-down") {
    return errorResponse(400, "slow_down");
  }
  if (deviceCode === "denied") {
    return errorResponse(
      400,
      "access_denied",
      "User denied the device authorization request",
    );
  }
  if (deviceCode === "expired") {
    return errorResponse(400, "expired_token", "Device authorization expired");
  }
  if (deviceCode === "error") {
    return errorResponse(
      400,
      "invalid_request",
      "Synthetic device authorization error",
    );
  }
  return null;
}

function handleDeviceCode(body: URLSearchParams) {
  const clientId = body.get("client_id");
  if (!isTestOAuthDeviceClientId(clientId)) {
    return errorResponse(401, "invalid_client");
  }

  const deviceCode = body.get("device_code");
  if (!deviceCode) {
    return errorResponse(400, "invalid_request", "device_code required");
  }

  const error = deviceGrantErrorForDeviceCode(deviceCode);
  if (error) {
    return error;
  }
  if (!deviceCode.startsWith(`test-device:${clientId}:`)) {
    return errorResponse(400, "invalid_grant", "unknown device_code");
  }

  return {
    status: 200 as const,
    body: {
      access_token: `test-device-access:${clientId}:${deviceCode}`,
      token_type: "Bearer" as const,
      expires_in: DEFAULT_EXPIRES_IN,
      scope: "read",
    },
  };
}

function isPreviewSyntheticRefreshRequest(body: URLSearchParams): boolean {
  if (env("ENV") !== "preview") {
    return false;
  }
  return (
    body.get("grant_type") === "refresh_token" &&
    body.get("client_id") === TEST_OAUTH_CLIENT_ID &&
    body.get("client_secret") === TEST_OAUTH_CLIENT_SECRET &&
    isTestOAuthRefreshToken(body.get("refresh_token") ?? "")
  );
}

const token$ = command(async ({ get }, signal: AbortSignal) => {
  const request = get(request$);
  const testEndpointAllowed = isTestEndpointAllowed(request);
  if (!testEndpointAllowed && env("ENV") !== "preview") {
    return testEndpointNotFoundResponse();
  }

  const contentType = request.header("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    if (!testEndpointAllowed) {
      return testEndpointNotFoundResponse();
    }
    return errorResponse(400, "invalid_request", "expected form body");
  }

  const text = await request.text();
  signal.throwIfAborted();

  const body = new URLSearchParams(text);
  if (!testEndpointAllowed && !isPreviewSyntheticRefreshRequest(body)) {
    return testEndpointNotFoundResponse();
  }

  const grantType = body.get("grant_type");
  if (grantType === DEVICE_CODE_GRANT_TYPE) {
    return handleDeviceCode(body);
  }

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
