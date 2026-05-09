import { computed } from "ccstate";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  zeroAgentDetail,
  zeroAgentEnabledConnectorTypes,
  zeroAgentEnabledCustomConnectorIds,
  zeroAgentExists,
  zeroAgentList,
} from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route";

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

const listAgentsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const agents = await get(zeroAgentList(auth.orgId));
  return { status: 200 as const, body: [...agents] };
});

const getAgentInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentsByIdContract.get));
  const agent = await get(
    zeroAgentDetail({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

const getAgentUserConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroUserConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledTypes = await get(
    zeroAgentEnabledConnectorTypes({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledTypes: [...enabledTypes] } };
});

const getAgentCustomConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentCustomConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({ orgId: auth.orgId, agentId: params.id }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledIds = await get(
    zeroAgentEnabledCustomConnectorIds({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledIds: [...enabledIds] } };
});

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

export const zeroAgentsRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentsMainContract.list,
    handler: authRoute(agentReadAuth, listAgentsInner$),
  },
  {
    route: zeroAgentsByIdContract.get,
    handler: authRoute(agentReadAuth, getAgentInner$),
  },
  {
    route: zeroUserConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentUserConnectorsInner$),
  },
  {
    route: zeroAgentCustomConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentCustomConnectorsInner$),
  },
];
