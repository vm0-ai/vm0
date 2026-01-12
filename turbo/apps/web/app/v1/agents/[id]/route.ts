/**
 * Public API v1 - Agent by ID Endpoint
 *
 * GET /v1/agents/:id - Get agent details
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
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";

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

    return {
      status: 200 as const,
      body: {
        id: agent.id,
        name: agent.name,
        current_version_id: agent.headVersionId,
        created_at: agent.createdAt.toISOString(),
        updated_at: agent.updatedAt.toISOString(),
      },
    };
  },
});

const handler = createPublicApiHandler(publicAgentByIdContract, router);

export { handler as GET };
