import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { eq, desc } from "drizzle-orm";
import {
  getUserScopeByClerkId,
  getScopeBySlug,
  canAccessScope,
} from "../../../../../src/lib/scope/scope-service";
import { getEmailSharedAgents } from "../../../../../src/lib/agent/permission-service";

const router = tsr.router(composesListContract, {
  list: async ({ query, headers }) => {
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

    // Query own composes for this scope
    const ownComposes = await globalThis.services.db
      .select({
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
      })
      .from(agentComposes)
      .where(eq(agentComposes.scopeId, scopeId))
      .orderBy(desc(agentComposes.updatedAt));

    // When using default scope (no ?scope= param), also include email-shared agents
    let sharedComposes: {
      name: string;
      headVersionId: string | null;
      updatedAt: Date;
      scopeSlug: string;
    }[] = [];

    if (!query.scope) {
      const userEmail = await getUserEmail(userId);
      const shared = await getEmailSharedAgents(userId, userEmail);
      sharedComposes = shared;
    }

    // Combine: own agents first, then shared agents with scope/name format
    const allComposes = [
      ...ownComposes.map((c) => ({
        name: c.name,
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
      })),
      ...sharedComposes.map((c) => ({
        name: `${c.scopeSlug}/${c.name}`,
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
      })),
    ];

    return {
      status: 200 as const,
      body: {
        composes: allComposes,
      },
    };
  },
});

const handler = createHandler(composesListContract, router);

export { handler as GET };
