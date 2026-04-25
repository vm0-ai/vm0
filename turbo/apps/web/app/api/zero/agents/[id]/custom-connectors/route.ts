import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { eq, and, inArray } from "drizzle-orm";

const router = tsr.router(zeroAgentCustomConnectorsContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const [agent] = await globalThis.services.db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, params.id)))
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    const rows = await globalThis.services.db
      .select({ customConnectorId: userCustomConnectors.customConnectorId })
      .from(userCustomConnectors)
      .where(
        and(
          eq(userCustomConnectors.orgId, org.orgId),
          eq(userCustomConnectors.userId, userId),
          eq(userCustomConnectors.agentId, params.id),
        ),
      );

    return {
      status: 200 as const,
      body: {
        enabledIds: rows.map((r) => {
          return r.customConnectorId;
        }),
      },
    };
  },

  update: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const [agent] = await globalThis.services.db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, params.id)))
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Validate every id belongs to the caller's org. Anything else is either
    // a stale id (user deleted the connector in another tab) or a probe from
    // another org — either way, 400 is the right answer.
    if (body.enabledIds.length > 0) {
      const foundRows = await globalThis.services.db
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.orgId, org.orgId),
            inArray(orgCustomConnectors.id, body.enabledIds),
          ),
        );
      const foundSet = new Set(
        foundRows.map((r) => {
          return r.id;
        }),
      );
      const missing = body.enabledIds.filter((id) => {
        return !foundSet.has(id);
      });
      if (missing.length > 0) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Unknown custom connector ids: ${missing.join(", ")}`,
              code: "VALIDATION_ERROR",
            },
          },
        };
      }
    }

    const db = globalThis.services.db;

    // Replace full list atomically. Unlike user_connectors, we deliberately
    // do NOT trigger a recompose here — custom connectors have no skill side
    // effect, only a network-layer firewall rule.
    await db.transaction(async (tx) => {
      await tx
        .delete(userCustomConnectors)
        .where(
          and(
            eq(userCustomConnectors.orgId, org.orgId),
            eq(userCustomConnectors.userId, userId),
            eq(userCustomConnectors.agentId, params.id),
          ),
        );

      if (body.enabledIds.length > 0) {
        await tx.insert(userCustomConnectors).values(
          body.enabledIds.map((customConnectorId) => {
            return {
              orgId: org.orgId,
              userId,
              agentId: params.id,
              customConnectorId,
            };
          }),
        );
      }
    });

    return {
      status: 200 as const,
      body: { enabledIds: body.enabledIds },
    };
  },
});

const handler = createHandler(zeroAgentCustomConnectorsContract, router, {
  routeName: "zero.agents.custom-connectors",
});

export { handler as GET, handler as PUT };
