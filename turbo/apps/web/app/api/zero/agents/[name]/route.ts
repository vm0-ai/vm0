import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroAgentsByNameContract } from "@vm0/core";
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
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:zero-agents:name");

const router = tsr.router(zeroAgentsByNameContract, {
  get: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up compose by name + org
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
      })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Look up zero_agent metadata
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.name, params.name)),
      )
      .limit(1);

    return {
      status: 200 as const,
      body: {
        name: compose.name,
        agentComposeId: compose.id,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors: agent?.connectors ?? [],
        firewallPolicies: agent?.firewallPolicies ?? null,
      },
    };
  },

  update: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Verify agent exists
    const [existing] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Build compose content from connectors
    const content = buildComposeContent(params.name, body.connectors);

    // Run synchronous compose
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      orgSlug: org.slug,
      content,
    });

    if (!result) {
      return {
        status: 422 as const,
        body: {
          error: {
            message:
              "One or more connectors reference skills that are not cached. Please try again later.",
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
        orgId: org.orgId,
        name: result.composeName,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        connectors: body.connectors,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          updatedAt: now,
          connectors: body.connectors,
          ...(body.displayName !== undefined && {
            displayName: body.displayName,
          }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.sound !== undefined && { sound: body.sound }),
        },
      });

    log.info(`Updated zero agent: ${result.composeName}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, org.orgId),
          eq(zeroAgents.name, result.composeName),
        ),
      )
      .limit(1);

    return {
      status: 200 as const,
      body: {
        name: result.composeName,
        agentComposeId: result.composeId,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors: body.connectors,
        firewallPolicies: agent?.firewallPolicies ?? null,
      },
    };
  },

  updateMetadata: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up compose by name + org
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
      })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Upsert metadata — only overwrite fields explicitly provided
    const now = new Date();
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        orgId: org.orgId,
        name: params.name,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
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
        },
      });

    log.info(`Updated zero agent metadata: ${params.name}`);

    // Re-query to return actual persisted state
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.name, params.name)),
      )
      .limit(1);

    return {
      status: 200 as const,
      body: {
        name: compose.name,
        agentComposeId: compose.id,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors: agent?.connectors ?? [],
        firewallPolicies: agent?.firewallPolicies ?? null,
      },
    };
  },

  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Find compose by (orgId, name)
    const [compose] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Delete compose and metadata atomically
    await globalThis.services.db.transaction(async (tx) => {
      // Delete compose
      await tx.delete(agentComposes).where(eq(agentComposes.id, compose.id));

      // Delete zero_agents metadata (cascades to zero_agent_schedules via agentId FK)
      await tx
        .delete(zeroAgents)
        .where(
          and(
            eq(zeroAgents.orgId, org.orgId),
            eq(zeroAgents.name, params.name),
          ),
        );
    });

    log.info(`Deleted zero agent: ${params.name}`);

    return { status: 204 as const, body: undefined };
  },
});

const handler = createHandler(zeroAgentsByNameContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:name"),
});

export { handler as GET, handler as PUT, handler as PATCH, handler as DELETE };
