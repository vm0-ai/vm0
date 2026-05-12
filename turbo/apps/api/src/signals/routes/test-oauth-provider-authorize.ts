import { computed } from "ccstate";
import { testOAuthProviderAuthorizeContract } from "@vm0/api-contracts/contracts/test-oauth-provider-authorize";

import { queryOf } from "../context/request";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  mintAuthCode,
  parseTestOAuthScenario,
  TEST_OAUTH_CLIENT_ID,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const authorize$ = computed((get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testOAuthProviderAuthorizeContract.authorize));
  const clientId = query.client_id;
  const redirectUri = query.redirect_uri;
  const state = query.state;

  if (!clientId || !redirectUri || !state) {
    return {
      status: 400 as const,
      body: { error: "client_id, redirect_uri, and state are required" },
    };
  }

  if (clientId !== TEST_OAUTH_CLIENT_ID) {
    return { status: 400 as const, body: { error: "invalid_client" } };
  }

  const scenario = query.scenario
    ? parseTestOAuthScenario(query.scenario)
    : "success";
  if (scenario === null) {
    return { status: 400 as const, body: { error: "invalid_scenario" } };
  }

  const destination = new URL(redirectUri);
  destination.searchParams.set("code", mintAuthCode(scenario));
  destination.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { location: destination.toString() },
  });
});

export const testOAuthProviderAuthorizeRoutes: readonly RouteEntry[] = [
  {
    route: testOAuthProviderAuthorizeContract.authorize,
    handler: authorize$,
  },
];
