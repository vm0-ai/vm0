import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { eq, desc } from "drizzle-orm";
import {
  getUserScopeByClerkId,
  getScopeBySlug,
  canAccessScope,
} from "../../../../../src/lib/scope/scope-service";

const router = tsr.router(composesListContract, {
  list: async ({ query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Resolve scope: use provided scope or fall back to user's default scope
    let scopeId: string;
    if (query.scope) {
      const scope = await getScopeBySlug(query.scope);
      if (!scope) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Scope not found: ${query.scope}`,
              code: "BAD_REQUEST",
            },
          },
        };
      }

      // Check if user has access to this scope
      const hasAccess = await canAccessScope(userId, scope.id);
      if (!hasAccess) {
        return {
          status: 403 as const,
          body: {
            error: {
              message: "You don't have access to this scope",
              code: "FORBIDDEN",
            },
          },
        };
      }

      scopeId = scope.id;
    } else {
      const userScope = await getUserScopeByClerkId(userId);
      if (!userScope) {
        return {
          status: 403 as const,
          body: {
            error: {
              message:
                "Please set up your scope first. Login again with: vm0 login",
              code: "SCOPE_NOT_CONFIGURED",
            },
          },
        };
      }
      scopeId = userScope.id;
    }

    // Query all composes for this scope
    const composes = await globalThis.services.db
      .select({
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
      })
      .from(agentComposes)
      .where(eq(agentComposes.scopeId, scopeId))
      .orderBy(desc(agentComposes.updatedAt));

    return {
      status: 200 as const,
      body: {
        composes: composes.map((compose) => ({
          name: compose.name,
          headVersionId: compose.headVersionId,
          updatedAt: compose.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createHandler(composesListContract, router);

export { handler as GET };
