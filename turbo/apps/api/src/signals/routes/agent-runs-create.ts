import { command } from "ccstate";
import { runsMainContract } from "@vm0/api-contracts/contracts/runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { now } from "../external/time";
import { createAgentRun$ } from "../services/agent-run-create.service";
import type { RouteEntry } from "../route";

const createRunBody$ = bodyResultOf(runsMainContract.create);

const createRunInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
  const body = await get(createRunBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const auth = get(organizationAuthContext$);
  return await set(
    createAgentRun$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      body: body.data,
      apiStartTime,
      modelProviderType: body.data.modelProviderType,
    },
    signal,
  );
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
