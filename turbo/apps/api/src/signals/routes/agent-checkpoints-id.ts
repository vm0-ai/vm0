import { computed } from "ccstate";
import { checkpointsByIdContract } from "@vm0/api-contracts/contracts/sessions";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import { agentCheckpointById } from "../services/agent-checkpoints.service";
import type { RouteEntry } from "../route";

const checkpointNotFound = notFound("Checkpoint not found");

const getCheckpointByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(checkpointsByIdContract.getById));
  const checkpoint = await get(
    agentCheckpointById({
      checkpointId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  if (!checkpoint) {
    return checkpointNotFound;
  }

  return { status: 200 as const, body: checkpoint };
});

export const agentCheckpointsRoutes: readonly RouteEntry[] = [
  {
    route: checkpointsByIdContract.getById,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getCheckpointByIdInner$,
    ),
  },
];
