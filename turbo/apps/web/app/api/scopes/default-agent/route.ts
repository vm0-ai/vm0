import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { scopeDefaultAgentContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { eq, and } from "drizzle-orm";

const router = tsr.router(scopeDefaultAgentContract, {
  setDefaultAgent: async ({ query, body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { scope, member } = await resolveScope(userId, query.scope);

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
            eq(agentComposes.clerkOrgId, scope.clerkOrgId),
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
