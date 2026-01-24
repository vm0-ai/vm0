/**
 * Public API v1 - Agents Endpoints
 *
 * GET /v1/agents - List agents
 */
import { initServices } from "../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../src/lib/public-api/handler";
import { publicAgentsListContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../src/lib/scope/scope-service";
import { agentComposes } from "../../../src/db/schema/agent-compose";
import { eq, and, desc, gt } from "drizzle-orm";

const router = tsr.router(publicAgentsListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Build query conditions
    const conditions = [eq(agentComposes.scopeId, userScope.id)];

    // Filter by name if provided (case-insensitive - normalize to lowercase)
    if (query.name) {
      conditions.push(eq(agentComposes.name, query.name.toLowerCase()));
    }

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(agentComposes.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch agents
    const agents = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(and(...conditions))
      .orderBy(desc(agentComposes.createdAt))
      .limit(limit + 1); // Fetch one extra to check has_more

    // Determine pagination info
    const hasMore = agents.length > limit;
    const data = hasMore ? agents.slice(0, limit) : agents;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map((agent) => ({
          id: agent.id,
          name: agent.name,
          current_version_id: agent.headVersionId,
          created_at: agent.createdAt.toISOString(),
          updated_at: agent.updatedAt.toISOString(),
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicAgentsListContract, router);

export { handler as GET };
