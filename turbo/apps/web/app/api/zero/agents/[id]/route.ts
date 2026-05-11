import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { toFirewallPolicies } from "@vm0/connectors/firewall-types";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { serverSideCompose } from "../../../../../src/lib/infra/compose/server-side-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { buildComposeContent } from "../../../../../src/lib/zero/build-compose-content";
import { validateCustomSkills } from "../../../../../src/lib/zero/validate-custom-skills";
import {
  requireAgentPermission,
  requireAdminPermission,
} from "../../../../../src/lib/zero/require-agent-permission";
import {
  PUBLIC_AGENT_LIMIT,
  assertPrivateAgentsFeatureEnabled,
  countPublicAgents,
  visibleZeroAgentCondition,
} from "../../../../../src/lib/zero/agent-visibility";
import { deleteComposeById } from "../../../../../src/lib/infra/agent-compose/compose-service";
import { isBadRequest, isConflict } from "@vm0/api-services/errors";
import { validateModelSelection } from "../../../../../src/lib/zero/model-provider/validate-model-selection";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero-agents:id");

function createPublicAgentLimitResponse() {
  return createErrorResponse(
    "CONFLICT",
    "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
  );
}

function unauthenticatedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

type AgentUpdateBody = {
  displayName?: string | null;
  description?: string | null;
  sound?: string | null;
  avatarUrl?: string | null;
  customSkills?: string[];
  modelProviderId?: string | null;
  selectedModel?: string | null;
  preferPersonalProvider?: boolean;
  visibility?: "public" | "private";
};

async function requirePrivateAgentFeatureForVisibility(
  authCtx: Parameters<typeof assertPrivateAgentsFeatureEnabled>[0],
  orgId: string,
  visibility: AgentUpdateBody["visibility"] | null | undefined,
) {
  if (visibility !== "private") return null;
  return assertPrivateAgentsFeatureEnabled(authCtx, orgId);
}

async function requirePublicAgentSlotForVisibility(
  orgId: string,
  currentVisibility: AgentUpdateBody["visibility"] | null | undefined,
  nextVisibility: AgentUpdateBody["visibility"] | null | undefined,
) {
  if (nextVisibility !== "public" || currentVisibility === "public") {
    return null;
  }
  if ((await countPublicAgents(orgId)) < PUBLIC_AGENT_LIMIT) return null;
  return createPublicAgentLimitResponse();
}

async function requireVisibilityChangeAllowed(
  authCtx: Parameters<typeof assertPrivateAgentsFeatureEnabled>[0],
  orgId: string,
  currentVisibility: AgentUpdateBody["visibility"] | null | undefined,
  nextVisibility: AgentUpdateBody["visibility"] | null | undefined,
) {
  const unavailable = await requirePrivateAgentFeatureForVisibility(
    authCtx,
    orgId,
    nextVisibility,
  );
  if (unavailable) return unavailable;
  return requirePublicAgentSlotForVisibility(
    orgId,
    currentVisibility,
    nextVisibility,
  );
}

function requireAgentConfigurationPermission(
  existing: {
    owner: string | null;
    visibility: AgentUpdateBody["visibility"] | null;
  },
  member: { userId: string; role: string },
) {
  if (existing.owner) {
    return requireAgentPermission(
      existing.owner,
      member,
      "update agent configuration",
      { visibility: existing.visibility },
    );
  }
  return requireAdminPermission(member, "update agent configuration");
}

function requireVisibilityOwnerPermission(
  agentOwner: string | null,
  member: { userId: string; role: string },
  nextVisibility: AgentUpdateBody["visibility"] | null | undefined,
) {
  if (
    nextVisibility === undefined ||
    !agentOwner ||
    agentOwner === member.userId
  ) {
    return null;
  }
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only the agent owner can update agent visibility",
        code: "FORBIDDEN",
      },
    },
  };
}

async function requireVisibilityUpdateAllowed(
  authCtx: Parameters<typeof assertPrivateAgentsFeatureEnabled>[0],
  orgId: string,
  agentOwner: string | null,
  member: { userId: string; role: string },
  requestedVisibility: AgentUpdateBody["visibility"] | null | undefined,
  currentVisibility: AgentUpdateBody["visibility"] | null | undefined,
  nextVisibility: AgentUpdateBody["visibility"] | null | undefined,
) {
  const visibilityForbidden = requireVisibilityOwnerPermission(
    agentOwner,
    member,
    requestedVisibility,
  );
  if (visibilityForbidden) return visibilityForbidden;
  return requireVisibilityChangeAllowed(
    authCtx,
    orgId,
    currentVisibility,
    nextVisibility,
  );
}

async function validateCustomSkillsForUpdate(
  bodyCustomSkills: string[] | undefined,
  customSkills: string[],
  orgId: string,
) {
  if (!bodyCustomSkills) return null;
  const validation = await validateCustomSkills(customSkills, orgId);
  return validation.valid ? null : validation.error;
}

function buildAgentUpsertConflictSet(body: AgentUpdateBody, now: Date) {
  return {
    updatedAt: now,
    ...(body.displayName !== undefined && { displayName: body.displayName }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.sound !== undefined && { sound: body.sound }),
    ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
    ...(body.customSkills !== undefined && { customSkills: body.customSkills }),
    ...(body.modelProviderId !== undefined && {
      modelProviderId: body.modelProviderId,
    }),
    ...(body.selectedModel !== undefined && {
      selectedModel: body.selectedModel,
    }),
    ...(body.preferPersonalProvider !== undefined && {
      preferPersonalProvider: body.preferPersonalProvider,
    }),
    ...(body.visibility !== undefined && { visibility: body.visibility }),
  };
}

function agentResponseBody(
  agent: typeof zeroAgents.$inferSelect | undefined,
  fallback: { id: string; ownerId: string },
) {
  if (!agent) {
    return {
      agentId: fallback.id,
      ownerId: fallback.ownerId,
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      permissionPolicies: toFirewallPolicies(undefined, undefined),
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public" as const,
    };
  }
  return {
    agentId: fallback.id,
    ownerId: agent.owner,
    description: agent.description,
    displayName: agent.displayName,
    sound: agent.sound,
    avatarUrl: agent.avatarUrl,
    permissionPolicies: toFirewallPolicies(
      agent.permissionPolicies,
      agent.unknownPermissionPolicies,
    ),
    customSkills: agent.customSkills,
    modelProviderId: agent.modelProviderId,
    selectedModel: agent.selectedModel,
    preferPersonalProvider: agent.preferPersonalProvider,
    visibility: agent.visibility,
  };
}

const router = tsr.router(zeroAgentsByIdContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return unauthenticatedResponse();

    const { org } = await resolveOrg(authCtx);

    // Look up agent directly — params.id is the composeId which is also the PK
    const [row] = await globalThis.services.db
      .select({
        agent: zeroAgents,
        composeUserId: agentComposes.userId,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(
        and(
          eq(zeroAgents.orgId, org.orgId),
          eq(zeroAgents.id, params.id),
          visibleZeroAgentCondition(authCtx.userId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: agentResponseBody(row.agent, {
        id: row.agent.id,
        ownerId: row.composeUserId,
      }),
    };
  },

  update: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Verify agent exists — need compose name for serverSideCompose
    // Join zeroAgents to get customSkills in the same query
    const [existing] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        customSkills: zeroAgents.customSkills,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.id, params.id),
        ),
      )
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Only agent owner or org admin can update.
    // When no zeroAgents row exists (owner is null), fall back to admin-only.
    const forbidden = requireAgentConfigurationPermission(existing, member);
    if (forbidden) return forbidden;

    const nextVisibility = body.visibility ?? existing.visibility ?? "public";
    const visibilityError = await requireVisibilityUpdateAllowed(
      authCtx,
      org.orgId,
      existing.owner,
      member,
      body.visibility,
      existing.visibility,
      nextVisibility,
    );
    if (visibilityError) return visibilityError;

    try {
      await validateModelSelection({
        orgId: org.orgId,
        modelProviderId: body.modelProviderId,
        selectedModel: body.selectedModel,
      });
    } catch (error) {
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      throw error;
    }

    // Use provided customSkills if present, otherwise keep existing
    const customSkills = body.customSkills ?? existing.customSkills ?? [];

    // Validate custom skill names when explicitly provided
    const customSkillsError = await validateCustomSkillsForUpdate(
      body.customSkills,
      customSkills,
      org.orgId,
    );
    if (customSkillsError) return customSkillsError;

    // Build compose content (all connector skills included)
    const content = buildComposeContent(existing.name);

    // Run synchronous compose
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      content,
    });

    if (!result) {
      return {
        status: 422 as const,
        body: {
          error: {
            message:
              "One or more skills are not cached. Please try again later.",
            code: "UNPROCESSABLE_ENTITY",
          },
        },
      };
    }

    // Write metadata to zero_agents — only overwrite fields explicitly provided
    const now = new Date();
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        id: result.composeId,
        orgId: org.orgId,
        name: result.composeName,
        owner: userId,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        customSkills,
        modelProviderId: body.modelProviderId ?? null,
        selectedModel: body.selectedModel ?? null,
        preferPersonalProvider: body.preferPersonalProvider ?? false,
        visibility: nextVisibility,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: buildAgentUpsertConflictSet(body, now),
      });

    log.info(`Updated zero agent: ${result.composeName}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(eq(zeroAgents.id, params.id))
      .limit(1);

    return {
      status: 200 as const,
      body: agentResponseBody(agent, { id: params.id, ownerId: userId }),
    };
  },

  updateMetadata: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Look up agent directly by id
    const [existing] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, params.id)))
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Only agent owner or org admin can update profile
    const forbidden = requireAgentPermission(
      existing.owner,
      member,
      "update agent profile",
      { visibility: existing.visibility },
    );
    if (forbidden) return forbidden;

    const visibilityError = await requireVisibilityUpdateAllowed(
      authCtx,
      org.orgId,
      existing.owner,
      member,
      body.visibility,
      existing.visibility,
      body.visibility,
    );
    if (visibilityError) return visibilityError;

    try {
      await validateModelSelection({
        orgId: org.orgId,
        modelProviderId: body.modelProviderId,
        selectedModel: body.selectedModel,
      });
    } catch (error) {
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      throw error;
    }

    // Update metadata — only overwrite fields explicitly provided
    const now = new Date();
    await globalThis.services.db
      .update(zeroAgents)
      .set({
        updatedAt: now,
        ...(body.displayName !== undefined && {
          displayName: body.displayName,
        }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.sound !== undefined && { sound: body.sound }),
        ...(body.avatarUrl !== undefined && {
          avatarUrl: body.avatarUrl,
        }),
        ...(body.modelProviderId !== undefined && {
          modelProviderId: body.modelProviderId,
        }),
        ...(body.selectedModel !== undefined && {
          selectedModel: body.selectedModel,
        }),
        ...(body.preferPersonalProvider !== undefined && {
          preferPersonalProvider: body.preferPersonalProvider,
        }),
        ...(body.visibility !== undefined && {
          visibility: body.visibility,
        }),
      })
      .where(eq(zeroAgents.id, params.id));

    log.info(`Updated zero agent metadata: ${existing.name}`);

    // Re-query to return actual persisted state
    const [updatedAgent] = await globalThis.services.db
      .select({
        agent: zeroAgents,
        composeUserId: agentComposes.userId,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(eq(zeroAgents.id, params.id))
      .limit(1);

    return {
      status: 200 as const,
      body: agentResponseBody(updatedAgent?.agent, {
        id: params.id,
        ownerId: updatedAgent?.composeUserId ?? authCtx.userId,
      }),
    };
  },

  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:delete",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Verify agent exists
    const [agent] = await globalThis.services.db
      .select({
        id: zeroAgents.id,
        name: zeroAgents.name,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
      })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, params.id)))
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Only agent owner or org admin can delete
    const forbidden = requireAgentPermission(
      agent.owner,
      member,
      "delete agent",
      { visibility: agent.visibility },
    );
    if (forbidden) return forbidden;

    // Delete compose with full cleanup (cascade + S3 instructions volume)
    try {
      await deleteComposeById(agent.id, agent.name, org.orgId);
    } catch (error) {
      if (isConflict(error)) {
        return {
          status: 409 as const,
          body: {
            error: {
              message: error.message,
              code: "CONFLICT",
            },
          },
        };
      }
      throw error;
    }

    log.info(`Deleted zero agent: ${agent.name}`);

    return { status: 204 as const, body: undefined };
  },
});

const handler = createHandler(zeroAgentsByIdContract, router, {
  routeName: "zero.agents.byId",
});

export { handler as GET, handler as PUT, handler as PATCH, handler as DELETE };
