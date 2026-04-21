import { and, eq } from "drizzle-orm";
import { onboardingCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { orgMembersMetadata } from "../../../../../src/db/schema/org-members-metadata";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { userConnectors } from "../../../../../src/db/schema/user-connector";

/**
 * POST /api/zero/onboarding/complete
 *
 * Marks member onboarding as done and — if the member selected any connectors
 * during the unified step 2 — inserts `user_connectors` rows for the org's
 * existing default agent. No new agent is created here; admins do that via
 * /setup.
 */
const router = tsr.router(onboardingCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization ?? undefined);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const db = globalThis.services.db;

    const now = new Date();
    await db
      .insert(orgMembersMetadata)
      .values({
        orgId: org.orgId,
        userId,
        onboardingDone: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          onboardingDone: true,
          updatedAt: now,
        },
      });

    const selectedConnectors = body.selectedConnectors ?? [];
    if (selectedConnectors.length > 0) {
      const [orgRow] = await db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, org.orgId))
        .limit(1);

      const agentId = orgRow?.defaultAgentId;
      if (agentId) {
        await db.transaction(async (tx) => {
          await tx
            .delete(userConnectors)
            .where(
              and(
                eq(userConnectors.orgId, org.orgId),
                eq(userConnectors.userId, userId),
                eq(userConnectors.agentId, agentId),
              ),
            );
          await tx.insert(userConnectors).values(
            selectedConnectors.map((connectorType) => {
              return {
                orgId: org.orgId,
                userId,
                agentId,
                connectorType,
              };
            }),
          );
        });
      }
    }

    return {
      status: 200 as const,
      body: { ok: true },
    };
  },
});

const handler = createHandler(onboardingCompleteContract, router, {
  routeName: "zero.onboarding.complete",
});

export { handler as POST };
