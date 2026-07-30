import { command } from "ccstate";
import { testAgentRunsContract } from "@vm0/api-contracts/contracts/test-agent-runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { now } from "../external/time";
import { createAgentRun$ } from "../services/agent-run-create.service";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const createRunBody$ = bodyResultOf(testAgentRunsContract.create);

const createRunInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
  const timing = new ApiDispatchTimingCollector();
  const body = await timing.measure(
    "api_dispatch_pre_create_direct_parse_body",
    "nested",
    async () => {
      return await get(createRunBody$);
    },
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const args = await timing.measure(
    "api_dispatch_pre_create_direct_prepare_args",
    "nested",
    () => {
      const auth = get(organizationAuthContext$);
      return {
        userId: auth.userId,
        orgId: auth.orgId,
        body: { ...body.data, triggerSource: "test" as const },
        apiStartTime,
        modelProviderType: body.data.modelProviderType,
        timing,
      };
    },
  );
  signal.throwIfAborted();
  return await set(createAgentRun$, args, signal);
});

const createRun$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  return await set(createRunInner$, signal);
});

export const testAgentRunsRoutes: readonly RouteEntry[] = [
  {
    route: testAgentRunsContract.create,
    handler: authRoute({ requireOrganization: true }, createRun$),
  },
];
