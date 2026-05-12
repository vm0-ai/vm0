import { command, computed } from "ccstate";
import {
  zeroAgentInstructionsContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import {
  requireAdminPermission,
  requireAgentPermission,
} from "../../lib/require-agent-permission";
import { serverSideZeroAgentCompose$ } from "../services/agent-compose.service";
import {
  agentResponse,
  defaultAgentResponse,
} from "../services/zero-agent-data.service";
import { zeroAgentInstructions } from "../services/zero-agent-instructions.service";
import { zeroSkillDetail } from "../services/zero-skill-detail.service";
import type { RouteEntry } from "../route";

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const agentWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
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

const updateAgentInstructionsBody$ = bodyResultOf(
  zeroAgentInstructionsContract.update,
);

const updateAgentInstructionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
    const params = get(pathParamsOf(zeroAgentInstructionsContract.update));
    const body = await get(updateAgentInstructionsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const [compose] = await writeDb
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, auth.orgId),
          eq(agentComposes.id, params.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!compose) {
      return notFound(`Agent not found: ${params.id}`);
    }

    const permissionError = compose.owner
      ? requireAgentPermission(
          compose.owner,
          member,
          "update agent instructions",
          { visibility: compose.visibility },
        )
      : requireAdminPermission(member, "update agent instructions");
    if (permissionError) {
      return permissionError;
    }

    const result = await set(
      serverSideZeroAgentCompose$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        agentComposeId: compose.id,
        agentName: compose.name,
        instructions: body.data.content,
      },
      signal,
    );
    signal.throwIfAborted();

    const [agent] = await writeDb
      .select({
        agentId: zeroAgents.id,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        permissionPolicies: zeroAgents.permissionPolicies,
        unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
        customSkills: zeroAgents.customSkills,
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
        preferPersonalProvider: zeroAgents.preferPersonalProvider,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, auth.orgId),
          eq(zeroAgents.name, compose.name),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: agent
        ? agentResponse(agent)
        : defaultAgentResponse({
            agentId: result.composeId,
            ownerId: auth.userId,
          }),
    };
  },
);

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
    handler: authRoute(agentReadAuth, getAgentInstructionsInner$),
  },
  {
    route: zeroAgentInstructionsContract.update,
    handler: authRoute(agentWriteAuth, updateAgentInstructionsInner$),
  },
  {
    route: zeroSkillsDetailContract.get,
    handler: authRoute(agentReadAuth, getSkillDetailInner$),
  },
];
