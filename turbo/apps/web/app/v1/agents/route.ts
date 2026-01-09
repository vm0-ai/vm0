/**
 * Public API v1 - Agents Endpoints
 *
 * GET /v1/agents - List agents
 * POST /v1/agents - Create agent
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
import {
  agentComposes,
  agentComposeVersions,
} from "../../../src/db/schema/agent-compose";
import { eq, and, desc, gt } from "drizzle-orm";
import { computeComposeVersionId } from "../../../src/lib/agent-compose/content-hash";
import type { AgentComposeYaml } from "../../../src/types/agent-compose";

const router = tsr.router(publicAgentsListContract, {
  list: async ({ query }) => {
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

    // Build query conditions
    const conditions = [eq(agentComposes.scopeId, userScope.id)];

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

  create: async ({ body }) => {
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

    const { name, config } = body;

    // Check if agent with this name already exists in user's scope
    const existing = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.scopeId, userScope.id),
          eq(agentComposes.name, name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return {
        status: 409 as const,
        body: {
          error: {
            type: "conflict_error" as const,
            code: "resource_already_exists",
            message: `An agent with this identifier already exists: '${name}'`,
          },
        },
      };
    }

    // Compute content-addressable version ID
    const versionId = computeComposeVersionId(config as AgentComposeYaml);

    // Create the agent compose
    const [created] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId: auth.userId,
        scopeId: userScope.id,
        name,
      })
      .returning();

    if (!created) {
      return {
        status: 500 as const,
        body: {
          error: {
            type: "api_error" as const,
            code: "internal_error",
            message: "Failed to create agent",
          },
        },
      };
    }

    // Create the initial version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: created.id,
      content: config,
      createdBy: auth.userId,
    });

    // Update HEAD pointer
    await globalThis.services.db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, created.id));

    return {
      status: 201 as const,
      body: {
        id: created.id,
        name: created.name,
        current_version_id: versionId,
        created_at: created.createdAt.toISOString(),
        updated_at: created.updatedAt.toISOString(),
        config,
      },
    };
  },
});

const handler = createPublicApiHandler(publicAgentsListContract, router);

export { handler as GET, handler as POST };
