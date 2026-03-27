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
import { isDefaultAgentCompose } from "../../../../../src/lib/zero/resolve-default-agent";
import { deleteComposeById } from "../../../../../src/lib/agent-compose/compose-service";
import { isConflict } from "../../../../../src/lib/errors";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:zero-agents:id");

type ForbiddenResponse = {
  status: 403;
  body: { error: { message: string; code: string } };
};

function agentResponseBody(
  agent: typeof zeroAgents.$inferSelect | undefined,
  fallback: { id: string; connectors?: string[] },
) {
  return {
    agentId: fallback.id,
    description: agent?.description ?? null,
    displayName: agent?.displayName ?? null,
    sound: agent?.sound ?? null,
    avatarUrl: agent?.avatarUrl ?? null,
    connectors: fallback.connectors ?? agent?.connectors ?? [],
    firewallPolicies: agent?.firewallPolicies ?? null,
  };
}

async function requireAdminForDefaultAgent(
  orgId: string,
  composeId: string,
  memberRole: string,
  label: string,
): Promise<ForbiddenResponse | null> {
  if (memberRole === "admin") return null;
  const isDefault = await isDefaultAgentCompose(orgId, composeId);
  if (!isDefault) return null;
  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only org admins can update the default agent's ${label}`,
        code: "FORBIDDEN",
      },
    },
  };
}

const router = tsr.router(zeroAgentsByIdContract, {
  get: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

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

  update: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    // Verify agent exists — need compose name for serverSideCompose
    const [existing] = await globalThis.services.db
      .select({ id: agentComposes.id, name: agentComposes.name })
      .from(agentComposes)
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

    // Build compose content from connectors
    const content = buildComposeContent(existing.name, body.connectors);

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
        id: result.composeId,
        orgId: org.orgId,
        name: result.composeName,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
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
          ...(body.avatarUrl !== undefined && {
            avatarUrl: body.avatarUrl,
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
      body: agentResponseBody(agent, {
        id: params.id,
        connectors: body.connectors,
      }),
    };
  },

  updateMetadata: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

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

  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

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
