import { testOAuthProviderRevokeContract } from "@vm0/api-contracts/contracts/test-oauth-provider-revoke";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  isTestOAuthAccessToken,
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

function errorResponse(status: 400 | 401, error: string) {
  return { status, body: { error } };
}

const revoke$ = command(async ({ get }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const contentType = request.header("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return errorResponse(400, "invalid_request");
  }

  const body = new URLSearchParams(await request.text());
  signal.throwIfAborted();
  if (
    body.get("client_id") !== TEST_OAUTH_CLIENT_ID ||
    body.get("client_secret") !== TEST_OAUTH_CLIENT_SECRET
  ) {
    return errorResponse(401, "invalid_client");
  }

  const token = body.get("token");
  if (!token || !isTestOAuthAccessToken(token)) {
    return errorResponse(400, "invalid_token");
  }
  return { status: 200 as const, body: { revoked: true as const } };
});

export const testOAuthProviderRevokeRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderRevokeContract.revoke,
    handler: revoke$,
  },
];
