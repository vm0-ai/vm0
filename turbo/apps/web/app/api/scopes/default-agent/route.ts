import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { scopeDefaultAgentContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";

const router = tsr.router(scopeDefaultAgentContract, {
  setDefaultAgent: async ({ query, body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    const { org, member } = await resolveOrg(
      userId,
      query.scope,
      query.org,
      tokenOrgId,
    );

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
            eq(agentComposes.orgId, org.orgId),
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

    const client = await clerkClient();
    await client.organizations.updateOrganizationMetadata(org.orgId, {
      publicMetadata: { default_agent_compose_id: agentComposeId },
    });

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
