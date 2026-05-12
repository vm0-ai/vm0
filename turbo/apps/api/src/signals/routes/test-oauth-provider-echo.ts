import { computed } from "ccstate";
import { testOAuthProviderEchoContract } from "@vm0/api-contracts/contracts/test-oauth-provider-echo";

import { nowDate } from "../../lib/time";
import { authorization$, request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  bearerTokenFrom,
  isTestEndpointAllowed,
  isTestOAuthAccessToken,
  isTestOAuthAccessTokenExpired,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const echo$ = computed((get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const authorization = get(authorization$) ?? "";
  const token = bearerTokenFrom(authorization);
  if (!token || !isTestOAuthAccessToken(token)) {
    return { status: 401 as const, body: { error: "invalid_token" } };
  }
  if (isTestOAuthAccessTokenExpired(token)) {
    return { status: 401 as const, body: { error: "expired_token" } };
  }

  return {
    status: 200 as const,
    body: {
      authorization,
      receivedAt: nowDate().toISOString(),
    },
  };
});

export const testOAuthProviderEchoRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderEchoContract.echo,
    handler: echo$,
  },
];
