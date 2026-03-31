import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroAgentsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../../src/lib/compose/server-side-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { buildComposeContent } from "../../../../../src/lib/zero/build-compose-content";
import { requireAdminForDefaultAgent } from "../../../../../src/lib/zero/require-admin";
import { deleteComposeById } from "../../../../../src/lib/agent-compose/compose-service";
import { isConflict } from "../../../../../src/lib/errors";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:zero-agents:id");

function agentResponseBody(
  agent: typeof zeroAgents.$inferSelect | undefined,
  fallback: { id: string },
) {
  return {
    agentId: fallback.id,
    description: agent?.description ?? null,
    displayName: agent?.displayName ?? null,
    sound: agent?.sound ?? null,
    avatarUrl: agent?.avatarUrl ?? null,
    firewallPolicies: agent?.firewallPolicies ?? null,
    customSkills: agent?.customSkills ?? [],
  };
}

const router = tsr.router(zeroAgentsByIdContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    // Look up agent directly — params.id is the composeId which is also the PK
    const [agent] = await globalThis.services.db
      .select()
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

    return {
      status: 200 as const,
      body: agentResponseBody(agent, { id: agent.id }),
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

    // Only admins can update the default agent
    const forbidden = await requireAdminForDefaultAgent(
      org.orgId,
      existing.id,
      member.role,
      "configuration",
    );
    if (forbidden) return forbidden;

    // Use provided customSkills if present, otherwise keep existing
    const customSkills = body.customSkills ?? existing.customSkills ?? [];

    // Build compose content (all connector skills included, plus custom skills)
    const content = buildComposeContent(
      existing.name,
      customSkills.map((name) => {
        return { name };
      }),
    );

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
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        customSkills,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
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
          ...(body.customSkills !== undefined && {
            customSkills: body.customSkills,
          }),
        },
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
      body: agentResponseBody(agent, { id: params.id }),
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

    // Only admins can update the default agent's profile
    const forbidden = await requireAdminForDefaultAgent(
      org.orgId,
      existing.id,
      member.role,
      "profile",
    );
    if (forbidden) return forbidden;

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
      })
      .where(eq(zeroAgents.id, params.id));

    log.info(`Updated zero agent metadata: ${existing.name}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(eq(zeroAgents.id, params.id))
      .limit(1);

    return {
      status: 200 as const,
      body: agentResponseBody(agent, { id: params.id }),
    };
  },

  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Verify agent exists
    const [agent] = await globalThis.services.db
      .select({ id: zeroAgents.id, name: zeroAgents.name })
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

    // Only admins can delete the default agent
    const forbidden = await requireAdminForDefaultAgent(
      org.orgId,
      agent.id,
      member.role,
      "agent",
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
  errorHandler: createSafeErrorHandler("zero-agents:id"),
});

export { handler as GET, handler as PUT, handler as PATCH, handler as DELETE };
