import { command } from "ccstate";
import { runsMainContract } from "@vm0/api-contracts/contracts/runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { now } from "../external/time";
import { createAgentRun$ } from "../services/agent-run-create.service";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import type { RouteEntry } from "../route-entry";

const createRunBody$ = bodyResultOf(runsMainContract.create);

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
        body: body.data,
        apiStartTime,
        modelProviderType: body.data.modelProviderType,
        timing,
      };
    },
  );
  signal.throwIfAborted();
  return await set(createAgentRun$, args, signal);
});

export const agentRunsCreateRoutes: readonly RouteEntry[] = [
  {
    route: runsMainContract.create,
    handler: authRoute(
      {
        acceptAnySandboxCapability: true,
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createRunInner$,
    ),
  },
];
