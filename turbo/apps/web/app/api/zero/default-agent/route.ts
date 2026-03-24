import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { orgDefaultAgentContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { orgMetadata as orgTable } from "../../../../src/db/schema/org-metadata";
import { eq, and } from "drizzle-orm";

const router = tsr.router(orgDefaultAgentContract, {
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

    const { org, member } = await resolveOrg(authCtx, undefined, query.org);

    if (member.role !== "admin") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only org admins can set the default agent",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const { agentId } = body;

    // Once a default agent is configured, prevent any further changes.
    const [orgRow] = await globalThis.services.db
      .select({ defaultAgentId: orgTable.defaultAgentId })
      .from(orgTable)
      .where(eq(orgTable.orgId, org.orgId))
      .limit(1);
    const existingAgentId = orgRow?.defaultAgentId ?? null;
    if (existingAgentId) {
      // Verify the existing agent still exists and belongs to this org —
      // if it was deleted or belongs to another org, allow re-setting.
      const [existing] = await globalThis.services.db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.id, existingAgentId),
            eq(zeroAgents.orgId, org.orgId),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          status: 409 as const,
          body: {
            error: {
              message: "A default agent is already configured for this org",
              code: "CONFLICT",
            },
          },
        };
      }
    }

    // agentId from frontend is a compose UUID — resolve to zero agent UUID
    let zeroAgentId: string | null = null;
    if (agentId !== null) {
      // Verify compose exists and belongs to this org
      const [compose] = await globalThis.services.db
        .select({
          id: agentComposes.id,
          name: agentComposes.name,
          orgId: agentComposes.orgId,
        })
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.id, agentId),
            eq(agentComposes.orgId, org.orgId),
          ),
        )
        .limit(1);

      if (!compose) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: "Agent not found in this org",
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Resolve compose → zero agent via (orgId, name)
      const [agent] = await globalThis.services.db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.orgId, compose.orgId),
            eq(zeroAgents.name, compose.name),
          ),
        )
        .limit(1);

      if (!agent) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: "Agent not found in this org",
              code: "NOT_FOUND",
            },
          },
        };
      }

      zeroAgentId = agent.id;
    }

    await globalThis.services.db
      .insert(orgTable)
      .values({ orgId: org.orgId, defaultAgentId: zeroAgentId })
      .onConflictDoUpdate({
        target: orgTable.orgId,
        set: { defaultAgentId: zeroAgentId, updatedAt: new Date() },
      });

    // Return compose UUID for backward compatibility
    return {
      status: 200 as const,
      body: {
        agentId,
      },
    };
  },
});

const handler = createHandler(orgDefaultAgentContract, router, {
  errorHandler: createSafeErrorHandler("zero-default-agent"),
});

export { handler as PUT };
