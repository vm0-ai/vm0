import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { scopeDefaultAgentContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:scopes:default-agent");

const router = tsr.router(scopeDefaultAgentContract, {
  setDefaultAgent: async ({ query, body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const { scope, member } = await resolveScope(
      userId,
      query.scope,
      query.org,
      tokenScopeId,
    );

    if (member.role !== "admin") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only scope admins can set the default agent",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const { agentComposeId } = body;

    if (agentComposeId !== null) {
      // Verify agent exists and belongs to this scope
      const [compose] = await globalThis.services.db
        .select({ id: agentComposes.id })
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.id, agentComposeId),
            eq(agentComposes.orgId, scope.orgId),
          ),
        )
        .limit(1);

      if (!compose) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: "Agent not found in this scope",
              code: "NOT_FOUND",
            },
          },
        };
      }
    }

    await globalThis.services.db
      .update(scopes)
      .set({ defaultAgentComposeId: agentComposeId })
      .where(eq(scopes.id, scope.id));

    // Dual-write to Clerk org publicMetadata (fire-and-forget)
    try {
      const client = await clerkClient();
      await client.organizations.updateOrganizationMetadata(scope.orgId, {
        publicMetadata: { default_agent_compose_id: agentComposeId },
      });
    } catch (err) {
      log.error("Failed to write default agent to Clerk metadata", {
        error: err,
        orgId: scope.orgId,
      });
    }

    return {
      status: 200 as const,
      body: {
        agentComposeId,
      },
    };
  },
});

const handler = createHandler(scopeDefaultAgentContract, router);

export { handler as PUT };
