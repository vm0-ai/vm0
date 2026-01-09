/**
 * Public API v1 - Agent Versions Endpoints
 *
 * GET /v1/agents/:id/versions - List agent versions
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicAgentVersionsContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../../../src/lib/scope/scope-service";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { eq, and, desc, gt } from "drizzle-orm";

const router = tsr.router(publicAgentVersionsContract, {
  list: async ({ params, query }) => {
    initServices();

    const auth = await authenticatePublicApi();
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

    // Find agent by ID, ensuring it belongs to user's scope
    const [agent] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.id, params.id),
          eq(agentComposes.scopeId, userScope.id),
        ),
      )
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such agent: '${params.id}'`,
          },
        },
      };
    }

    // Build query conditions for versions
    const conditions = [eq(agentComposeVersions.composeId, agent.id)];

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(agentComposeVersions.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch versions
    const versions = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(and(...conditions))
      .orderBy(desc(agentComposeVersions.createdAt))
      .limit(limit + 1); // Fetch one extra to check has_more

    // Determine pagination info
    const hasMore = versions.length > limit;
    const data = hasMore ? versions.slice(0, limit) : versions;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    // Get max version number (simple counter based on total versions)
    const allVersions = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, agent.id))
      .orderBy(agentComposeVersions.createdAt);

    // Create a map of version IDs to version numbers
    const versionNumberMap = new Map<string, number>();
    allVersions.forEach((v, index) => {
      versionNumberMap.set(v.id, index + 1);
    });

    return {
      status: 200 as const,
      body: {
        data: data.map((version) => ({
          id: version.id,
          agent_id: agent.id,
          version_number: versionNumberMap.get(version.id) ?? 1,
          config: version.content,
          created_at: version.createdAt.toISOString(),
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicAgentVersionsContract, router);

export { handler as GET };
