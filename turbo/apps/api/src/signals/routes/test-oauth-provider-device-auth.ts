import { command } from "ccstate";
import { testOAuthProviderDeviceAuthContract } from "@vm0/api-contracts/contracts/test-oauth-provider-device-auth";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  isTestOAuthDeviceClientId,
  isTestEndpointAllowed,
  TEST_OAUTH_DEVICE_USER_CODE,
  TEST_OAUTH_DEVICE_VERIFICATION_URI,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const DEFAULT_EXPIRES_IN = 600;
const DEFAULT_INTERVAL = 0;

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

const deviceAuth$ = command(async ({ get }, signal: AbortSignal) => {
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
  const clientId = body.get("client_id");
  if (!isTestOAuthDeviceClientId(clientId)) {
    return errorResponse(401, "invalid_client");
  }

  const scope = body.get("scope") ?? "";
  const mode = body.get("mode");
  const deviceCode = `test-device:${clientId}:${scope}${mode ? `:${mode}` : ""}`;
  return {
    status: 200 as const,
    body: {
      device_code: deviceCode,
      user_code: TEST_OAUTH_DEVICE_USER_CODE,
      verification_uri: TEST_OAUTH_DEVICE_VERIFICATION_URI,
      verification_uri_complete: `${TEST_OAUTH_DEVICE_VERIFICATION_URI}?user_code=${TEST_OAUTH_DEVICE_USER_CODE}`,
      expires_in: DEFAULT_EXPIRES_IN,
      interval: DEFAULT_INTERVAL,
    },
  };
});

export const testOAuthProviderDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderDeviceAuthContract.deviceAuth,
    handler: deviceAuth$,
  },
];
