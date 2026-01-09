import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { eq, desc } from "drizzle-orm";
import {
  getUserScopeByClerkId,
  getScopeBySlug,
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
      scopeId = scope.id;
    } else {
      const userScope = await getUserScopeByClerkId(userId);
      if (!userScope) {
        return {
          status: 400 as const,
          body: {
            error: {
              message:
                "Please set up your scope first. Login again with: vm0 login",
              code: "BAD_REQUEST",
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
