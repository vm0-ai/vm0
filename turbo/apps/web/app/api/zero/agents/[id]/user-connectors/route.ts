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
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { userConnectors } from "../../../../../../src/db/schema/user-connector";
import { eq, and } from "drizzle-orm";
import { buildComposeContent } from "../../../../../../src/lib/zero/build-compose-content";
import { serverSideCompose } from "../../../../../../src/lib/infra/compose/server-side-compose";
import { computeComposeVersionId } from "../../../../../../src/lib/infra/agent-compose/content-hash";
import type { AgentComposeYaml } from "../../../../../../src/lib/infra/agent-compose/types";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero-agents:user-connectors");

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

    // Verify agent exists — also fetch compose name and customSkills for recompose
    const [agent] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        customSkills: zeroAgents.customSkills,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.id, params.id),
        ),
      )
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

    // Recompose only if the compose is stale (missing new connector skills).
    const customSkills = agent.customSkills ?? [];
    const content = buildComposeContent(
      agent.name,
      customSkills.map((name) => {
        return { name };
      }),
    );
    const newVersionId = computeComposeVersionId(
      content as unknown as AgentComposeYaml,
    );
    if (newVersionId !== agent.headVersionId) {
      const composeResult = await serverSideCompose({
        userId,
        orgId: org.orgId,
        content,
      });
      if (composeResult) {
        log.info(
          `Recomposed agent ${params.id} after connector update (version: ${composeResult.versionId.slice(0, 8)})`,
        );
      }
    }

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
