import { command, computed } from "ccstate";
import { testAgentComposesContract } from "@vm0/api-contracts/contracts/test-agent-composes";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import { createAgentCompose$ } from "../services/agent-composes-create.service";
import { agentComposeByName } from "../services/agent-composes-read.service";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const createComposeBody$ = bodyResultOf(testAgentComposesContract.create);

const getComposeByNameInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(testAgentComposesContract.getByName));
  const compose = await get(
    agentComposeByName({ orgId: auth.orgId, name: query.name }),
  );
  if (!compose) {
    return notFound(`Agent compose not found: ${query.name}`);
  }
  return { status: 200 as const, body: compose };
});

const getComposeByName$ = computed(async (get) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  return await get(getComposeByNameInner$);
});

const createComposeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(createComposeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(
      createAgentCompose$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        content: body.data.content,
      },
      signal,
    );
  },
);

const createCompose$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  return await set(createComposeInner$, signal);
});

export const testAgentComposesRoutes: readonly RouteEntry[] = [
  {
    route: testAgentComposesContract.getByName,
    handler: authRoute({ requireOrganization: true }, getComposeByName$),
  },
  {
    route: testAgentComposesContract.create,
    handler: authRoute({ requireOrganization: true }, createCompose$),
  },
];
