/**
 * Public API v1 - Agent by ID Endpoints
 *
 * GET /v1/agents/:id - Get agent details
 * PUT /v1/agents/:id - Update agent
 * DELETE /v1/agents/:id - Delete agent
 */
import { initServices } from "../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../src/lib/public-api/handler";
import { publicAgentByIdContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../../src/lib/scope/scope-service";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { computeComposeVersionId } from "../../../../src/lib/agent-compose/content-hash";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";

const router = tsr.router(publicAgentByIdContract, {
  get: async ({ params }) => {
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

    // Get current version config if available
    let config: unknown = undefined;
    if (agent.headVersionId) {
      const [version] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agent.headVersionId))
        .limit(1);

      if (version) {
        config = version.content;
      }
    }

    return {
      status: 200 as const,
      body: {
        id: agent.id,
        name: agent.name,
        current_version_id: agent.headVersionId,
        created_at: agent.createdAt.toISOString(),
        updated_at: agent.updatedAt.toISOString(),
        config,
      },
    };
  },

  update: async ({ params, body }) => {
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

    const { config } = body;

    // Compute new version ID
    const versionId = computeComposeVersionId(config as AgentComposeYaml);

    // Check if this exact version already exists
    const [existingVersion] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId))
      .limit(1);

    if (!existingVersion) {
      // Create new version
      await globalThis.services.db.insert(agentComposeVersions).values({
        id: versionId,
        composeId: agent.id,
        content: config,
        createdBy: auth.userId,
      });
    }

    // Update HEAD pointer and timestamp
    const now = new Date();
    await globalThis.services.db
      .update(agentComposes)
      .set({
        headVersionId: versionId,
        updatedAt: now,
      })
      .where(eq(agentComposes.id, agent.id));

    return {
      status: 200 as const,
      body: {
        id: agent.id,
        name: agent.name,
        current_version_id: versionId,
        created_at: agent.createdAt.toISOString(),
        updated_at: now.toISOString(),
        config,
      },
    };
  },

  delete: async ({ params }) => {
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

    // Delete the agent (cascade will delete versions due to FK constraint)
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, agent.id));

    return {
      status: 204 as const,
      body: undefined,
    };
  },
});

const handler = createPublicApiHandler(publicAgentByIdContract, router);

export { handler as GET, handler as PUT, handler as DELETE };
