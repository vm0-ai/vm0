import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { zeroUserConnectorsContract, connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import { userConnectors } from "../../../../../../src/db/schema/user-connector";
import { eq, and } from "drizzle-orm";

const router = tsr.router(zeroUserConnectorsContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    // Verify agent exists in this org
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
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, org.orgId),
          eq(userConnectors.userId, userId),
          eq(userConnectors.agentId, params.id),
        ),
      );

    return {
      status: 200 as const,
      body: {
        enabledTypes: rows.map((r) => {
          return r.connectorType;
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

    // Verify agent exists in this org
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

    // Validate connector types before storing
    const invalidTypes = body.enabledTypes.filter((t) => {
      return !connectorTypeSchema.safeParse(t).success;
    });
    if (invalidTypes.length > 0) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Invalid connector types: ${invalidTypes.join(", ")}`,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    const db = globalThis.services.db;

    // Replace full list atomically
    await db.transaction(async (tx) => {
      await tx
        .delete(userConnectors)
        .where(
          and(
            eq(userConnectors.orgId, org.orgId),
            eq(userConnectors.userId, userId),
            eq(userConnectors.agentId, params.id),
          ),
        );

      if (body.enabledTypes.length > 0) {
        await tx.insert(userConnectors).values(
          body.enabledTypes.map((connectorType) => {
            return {
              orgId: org.orgId,
              userId,
              agentId: params.id,
              connectorType,
            };
          }),
        );
      }
    });

    return {
      status: 200 as const,
      body: { enabledTypes: body.enabledTypes },
    };
  },
});

const handler = createHandler(zeroUserConnectorsContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:user-connectors"),
});

export { handler as GET, handler as PUT };
