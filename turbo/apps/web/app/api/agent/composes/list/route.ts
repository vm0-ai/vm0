import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { eq, and, desc } from "drizzle-orm";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";

const router = tsr.router(composesListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    // Resolve org: use ?org= query param or default org
    let orgId: string;
    try {
      const { org: resolvedOrg } = await resolveOrg(authCtx, query.org);
      orgId = resolvedOrg.orgId;
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: "Invalid request", code: "BAD_REQUEST" },
          },
        };
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: {
            error: {
              message: "You don't have access to this org",
              code: "FORBIDDEN",
            },
          },
        };
      }
      throw error;
    }

    // Query composes with metadata from zero_agents
    const ownComposes = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        updatedAt: agentComposes.updatedAt,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(agentComposes)
      .leftJoin(
        zeroAgents,
        and(
          eq(agentComposes.orgId, zeroAgents.orgId),
          eq(agentComposes.name, zeroAgents.name),
        ),
      )
      .where(eq(agentComposes.orgId, orgId))
      .orderBy(desc(agentComposes.updatedAt));

    const allComposes = ownComposes.map((c) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName ?? null,
      description: c.description ?? null,
      sound: c.sound ?? null,
      headVersionId: c.headVersionId,
      updatedAt: c.updatedAt.toISOString(),
    }));

    return {
      status: 200 as const,
      body: {
        composes: allComposes,
      },
    };
  },
});

const handler = createHandler(composesListContract, router);

export { handler as GET };
