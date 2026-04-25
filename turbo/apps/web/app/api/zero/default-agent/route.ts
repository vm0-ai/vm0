import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgMetadata as orgTable } from "@vm0/db/schema/org-metadata";
import { eq, and } from "drizzle-orm";

const router = tsr.router(orgDefaultAgentContract, {
  setDefaultAgent: async ({ body, headers }) => {
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

    const { org, member } = await resolveOrg(authCtx);

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

    // agentId is the composeId (= zeroAgents PK) — store directly
    if (agentId !== null) {
      // Verify agent exists and belongs to this org
      const [agent] = await globalThis.services.db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(and(eq(zeroAgents.id, agentId), eq(zeroAgents.orgId, org.orgId)))
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
    }

    await globalThis.services.db
      .insert(orgTable)
      .values({ orgId: org.orgId, defaultAgentId: agentId })
      .onConflictDoUpdate({
        target: orgTable.orgId,
        set: { defaultAgentId: agentId, updatedAt: new Date() },
      });

    return {
      status: 200 as const,
      body: {
        agentId,
      },
    };
  },
});

const handler = createHandler(orgDefaultAgentContract, router, {
  routeName: "zero.default-agent",
});

export { handler as PUT };
