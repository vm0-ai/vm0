import { computed } from "ccstate";
import {
  zeroAgentInstructionsContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import { zeroAgentInstructions } from "../services/zero-agent-instructions.service";
import { zeroSkillDetail } from "../services/zero-skill-detail.service";
import type { RouteEntry } from "../route";

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const getAgentInstructionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentInstructionsContract.get));
  const result = await get(zeroAgentInstructions(auth.orgId, params.id));
  if (!result) {
    return notFound(`Agent not found: ${params.id}`);
  }
  return { status: 200 as const, body: result };
});

const getSkillDetailInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroSkillsDetailContract.get));
  const result = await get(zeroSkillDetail(auth.orgId, params.name));
  if (!result) {
    return notFound(`Skill not found: ${params.name}`);
  }
  return { status: 200 as const, body: result };
});

export const zeroAgentInstructionsRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentInstructionsContract.get,
    handler: shadowCompareRoute({
      route: zeroAgentInstructionsContract.get,
      handler: authRoute(agentReadAuth, getAgentInstructionsInner$),
    }),
  },
  {
    route: zeroSkillsDetailContract.get,
    handler: shadowCompareRoute({
      route: zeroSkillsDetailContract.get,
      handler: authRoute(agentReadAuth, getSkillDetailInner$),
    }),
  },
];
