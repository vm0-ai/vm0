import { computed } from "ccstate";
import { testOAuthProviderUserinfoContract } from "@vm0/api-contracts/contracts/test-oauth-provider-userinfo";

import { authorization$, request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  bearerTokenFrom,
  isTestEndpointAllowed,
  isTestOAuthAccessToken,
  isTestOAuthAccessTokenExpired,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const userinfo$ = computed((get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const token = bearerTokenFrom(get(authorization$) ?? "");
  if (!token || !isTestOAuthAccessToken(token)) {
    return { status: 401 as const, body: { error: "invalid_token" } };
  }
  if (isTestOAuthAccessTokenExpired(token)) {
    return { status: 401 as const, body: { error: "expired_token" } };
  }

  return {
    status: 200 as const,
    body: {
      id: "testoauth-user-1",
      username: "testoauth",
      email: "testoauth@example.com",
    },
  };
});

export const testOAuthProviderUserinfoRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderUserinfoContract.userinfo,
    handler: userinfo$,
  },
];
