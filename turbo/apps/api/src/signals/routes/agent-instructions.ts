import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { serverSideZeroAgentCompose$ } from "../services/agent-compose.service";
import { agentResponse } from "../services/agent-data.service";
import { agentInstructions } from "../services/agent-instructions.service";
import type { RouteEntry } from "../route-entry";

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
  const params = get(pathParamsOf(agentInstructionsContract.get));
  const result = await get(
    agentInstructions({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!result) {
    return notFound(`Agent not found: ${params.id}`);
  }
  return { status: 200 as const, body: result };
});

const updateAgentInstructionsBody$ = bodyResultOf(
  agentInstructionsContract.update,
);

const updateAgentInstructionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const publicBrand = get(publicBrand$);
    const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
    const params = get(pathParamsOf(agentInstructionsContract.update));
    const body = await get(updateAgentInstructionsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const [agentIdentity] = await writeDb
      .select({
        id: agents.id,
        name: agents.name,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
      .limit(1);
    signal.throwIfAborted();

    if (!agentIdentity) {
      return notFound(`Agent not found: ${params.id}`);
    }

    const permissionError = requireAgentPermission(
      agentIdentity.owner,
      member,
      "update agent instructions",
      { visibility: agentIdentity.visibility },
    );
    if (permissionError) {
      return permissionError;
    }

    const result = await set(
      serverSideZeroAgentCompose$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        agentComposeId: agentIdentity.id,
        agentName: agentIdentity.name,
        instructions: body.data.content,
      },
      signal,
    );
    signal.throwIfAborted();

    const [agent] = await writeDb
      .select({
        agentId: agents.id,
        defaultAgentId: orgMetadata.defaultAgentId,
        owner: agents.owner,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
        modelProviderId: agents.modelProviderId,
        selectedModel: agents.selectedModel,
        preferPersonalProvider: agents.preferPersonalProvider,
        visibility: agents.visibility,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, agentIdentity.id)))
      .limit(1);
    signal.throwIfAborted();

    if (!agent) {
      throw new Error(
        `Canonical Agent missing after update: ${result.composeId}`,
      );
    }

    return { status: 200 as const, body: agentResponse(agent, publicBrand) };
  },
);

export const agentInstructionsRoutes: readonly RouteEntry[] = [
  {
    route: agentInstructionsContract.get,
    handler: authRoute(agentReadAuth, getAgentInstructionsInner$),
  },
  {
    route: agentInstructionsContract.update,
    handler: authRoute(agentWriteAuth, updateAgentInstructionsInner$),
  },
];
