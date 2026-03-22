/**
 * PATCH /api/agent/composes/:id/metadata
 *
 * Update agent metadata (displayName, description, sound) directly
 * without triggering a compose job.
 */
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { composesMetadataContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { canAccessCompose } from "../../../../../../src/lib/agent/compose-access";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const router = tsr.router(composesMetadataContract, {
  updateMetadata: async ({ params, body, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    // Get compose
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, params.id))
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check access
    const orgId = (await resolveOrg(authResult)).org.orgId;
    const hasAccess = canAccessCompose(userId, orgId, compose);
    if (!hasAccess) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Upsert zero_agents with new metadata
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        orgId: compose.orgId,
        name: compose.name,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          ...(body.displayName !== undefined && {
            displayName: body.displayName,
          }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.sound !== undefined && { sound: body.sound }),
          updatedAt: new Date(),
        },
      });

    return {
      status: 200 as const,
      body: { ok: true as const },
    };
  },
});

const handler = createHandler(composesMetadataContract, router);

export { handler as PATCH };
