import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { toFirewallPolicies } from "@vm0/connectors/firewall-types";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { serverSideCompose } from "../../../../src/lib/infra/compose/server-side-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { and, eq, desc } from "drizzle-orm";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { buildComposeContent } from "../../../../src/lib/zero/build-compose-content";
import { validateCustomSkills } from "../../../../src/lib/zero/validate-custom-skills";
import {
  PUBLIC_AGENT_LIMIT,
  assertPrivateAgentsFeatureEnabled,
  countPublicAgents,
  visibleZeroAgentCondition,
} from "../../../../src/lib/zero/agent-visibility";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero-agents");

function unauthenticatedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

const router = tsr.router(zeroAgentsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    // Generate UUID agent name
    const agentName = crypto.randomUUID();

    const customSkills = body.customSkills ?? [];
    const visibility = body.visibility ?? "public";
    if (visibility === "private") {
      const unavailable = await assertPrivateAgentsFeatureEnabled(
        authCtx,
        org.orgId,
      );
      if (unavailable) return unavailable;
    }

    // Validate custom skill names exist in the org
    const validation = await validateCustomSkills(customSkills, org.orgId);
    if (!validation.valid) return validation.error;

    // Build compose content (always includes all connector skills)
    const content = buildComposeContent(agentName);

    // Run synchronous compose (pass empty instructions so the
    // agent-instructions storage record is created — without it,
    // schedule runs fail with "storage not found").
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      content,
      instructions: "",
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

    const metadata = {
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      sound: body.sound ?? null,
      avatarUrl: body.avatarUrl ?? null,
      customSkills,
      modelProviderId: body.modelProviderId ?? null,
      selectedModel: body.selectedModel ?? null,
      preferPersonalProvider: body.preferPersonalProvider ?? false,
      visibility,
    };

    // Enforce maximum 7 public agents per organization.
    // Lock existing agent rows with FOR UPDATE so concurrent creates for
    // the same org serialize. Then count — PostgreSQL forbids FOR UPDATE
    // on aggregate queries, so we lock and count in two steps.
    const txResult = await globalThis.services.db.transaction(async (tx) => {
      await tx
        .select()
        .from(zeroAgents)
        .where(eq(zeroAgents.orgId, org.orgId))
        .for("update");

      const agentCount =
        visibility === "public" ? await countPublicAgents(org.orgId, tx) : 0;

      if (agentCount >= PUBLIC_AGENT_LIMIT) {
        return { blocked: true as const };
      }

      // Write metadata to zero_agents (PK = composeId)
      await tx
        .insert(zeroAgents)
        .values({
          id: result.composeId,
          orgId: org.orgId,
          name: result.composeName,
          owner: userId,
          ...metadata,
        })
        .onConflictDoUpdate({
          target: [zeroAgents.orgId, zeroAgents.name],
          set: {
            ...metadata,
            updatedAt: new Date(),
          },
        });

      return { blocked: false as const };
    });

    if (txResult.blocked) {
      return createErrorResponse(
        "CONFLICT",
        "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
      );
    }

    log.info(`Created zero agent: ${result.composeName}`);

    return {
      status: 201 as const,
      body: {
        agentId: result.composeId,
        ownerId: userId,
        permissionPolicies: null,
        ...metadata,
      },
    };
  },

  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return unauthenticatedResponse();
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const rows = await globalThis.services.db
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
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(
        and(eq(zeroAgents.orgId, org.orgId), visibleZeroAgentCondition(userId)),
      )
      .orderBy(desc(zeroAgents.updatedAt));

    return {
      status: 200 as const,
      body: rows.map((row) => {
        return {
          agentId: row.agentId,
          ownerId: row.owner,
          displayName: row.displayName ?? null,
          description: row.description ?? null,
          sound: row.sound ?? null,
          avatarUrl: row.avatarUrl ?? null,
          permissionPolicies: toFirewallPolicies(
            row.permissionPolicies,
            row.unknownPermissionPolicies,
          ),
          modelProviderId: row.modelProviderId ?? null,
          selectedModel: row.selectedModel ?? null,
          preferPersonalProvider: row.preferPersonalProvider ?? false,
          visibility: row.visibility,
          customSkills: row.customSkills,
        };
      }),
    };
  },
});

const handler = createHandler(zeroAgentsMainContract, router, {
  routeName: "zero.agents",
});

export { handler as POST, handler as GET };
