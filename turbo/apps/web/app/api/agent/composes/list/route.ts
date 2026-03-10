import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { eq, desc } from "drizzle-orm";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";
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

    // Resolve scope: use ?scope= query param or default scope
    let scopeId: string;
    let defaultAgentComposeId: string | null = null;
    try {
      const { scope: resolvedScope } = await resolveScope(userId, query.scope);
      scopeId = resolvedScope.id;
      defaultAgentComposeId = resolvedScope.defaultAgentComposeId;
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      if (isForbidden(error)) {
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
      throw error;
    }

    // Query own composes for this scope
    const ownComposes = await globalThis.services.db
      .select({
        id: agentComposes.id,
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
        isOwner: true,
        isDefault: c.id === defaultAgentComposeId,
      })),
      ...sharedComposes.map((c) => ({
        name: `${c.scopeSlug}/${c.name}`,
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
        isOwner: false,
        isDefault: false,
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
