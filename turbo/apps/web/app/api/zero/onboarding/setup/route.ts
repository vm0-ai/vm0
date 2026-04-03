import { and, eq } from "drizzle-orm";
import { onboardingSetupContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { updateOrg } from "../../../../../src/lib/zero/org/org-service";
import { upsertOrgNoSecretModelProvider } from "../../../../../src/lib/zero/model-provider/model-provider-service";
import { serverSideCompose } from "../../../../../src/lib/infra/compose/server-side-compose";
import { buildComposeContent } from "../../../../../src/lib/zero/build-compose-content";
import { SEED_INSTRUCTIONS } from "../../../../../src/lib/zero/seed-instructions";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { orgMembersMetadata } from "../../../../../src/db/schema/org-members-metadata";
import { userConnectors } from "../../../../../src/db/schema/user-connector";
import { logger } from "../../../../../src/lib/shared/logger";
import { isBadRequest } from "../../../../../src/lib/shared/errors";

const log = logger("api:onboarding-setup");

/**
 * Try to set org name/slug with retry on conflict.
 * Mirrors the slug-retry logic that was previously in the frontend.
 */
async function tryUpdateOrgNameSlug(
  orgId: string,
  userId: string,
  workspaceName: string,
): Promise<void> {
  const name = workspaceName.trim();
  if (!name) return;

  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

  const slugCandidates = [
    baseSlug,
    `${baseSlug.slice(0, 56)}-${Math.random().toString(36).slice(2, 8)}`,
  ];

  for (const slug of slugCandidates) {
    if (slug.length < 3) continue;
    try {
      await updateOrg(orgId, userId, { name, slug, force: true });
      return;
    } catch (error) {
      if (isBadRequest(error) && String(error).includes("already exists")) {
        continue;
      }
      throw error;
    }
  }

  // Both slug attempts conflicted — update name only
  await updateOrg(orgId, userId, { name });
}

const router = tsr.router(onboardingSetupContract, {
  setup: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Only org admins can run onboarding setup",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const db = globalThis.services.db;

    // Idempotency: if a default agent already exists, return it
    const [orgRow] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, org.orgId))
      .limit(1);

    if (orgRow?.defaultAgentId) {
      const [existing] = await db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.id, orgRow.defaultAgentId),
            eq(zeroAgents.orgId, org.orgId),
          ),
        )
        .limit(1);

      if (existing) {
        return {
          status: 200 as const,
          body: { agentId: existing.id },
        };
      }
    }

    // Parallel group 1: org update + model provider (independent)
    const parallelGroup1: Promise<unknown>[] = [
      upsertOrgNoSecretModelProvider(org.orgId, "vm0", "claude-sonnet-4.6"),
    ];
    if (body.workspaceName) {
      parallelGroup1.push(
        tryUpdateOrgNameSlug(org.orgId, userId, body.workspaceName),
      );
    }
    await Promise.all(parallelGroup1);

    // Create agent with real seed instructions in a single serverSideCompose call
    const agentName = crypto.randomUUID();
    const content = buildComposeContent(agentName);

    const composeResult = await serverSideCompose({
      userId,
      orgId: org.orgId,
      content,
      instructions: SEED_INSTRUCTIONS,
    });

    if (!composeResult) {
      return {
        status: 422 as const,
        body: {
          error: {
            message:
              "One or more skills are not cached. Please try again later.",
            code: "UNPROCESSABLE_ENTITY",
          },
        },
      };
    }

    // Write agent metadata
    await db
      .insert(zeroAgents)
      .values({
        id: composeResult.composeId,
        orgId: org.orgId,
        name: composeResult.composeName,
        owner: userId,
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        customSkills: [],
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          displayName: body.displayName ?? null,
          sound: body.sound ?? null,
          avatarUrl: body.avatarUrl ?? null,
          updatedAt: new Date(),
        },
      });

    const agentId = composeResult.composeId;

    // Parallel group 2: connectors + default agent + mark complete
    const parallelGroup2: Promise<unknown>[] = [
      // Set default agent
      db
        .insert(orgMetadata)
        .values({ orgId: org.orgId, defaultAgentId: agentId })
        .onConflictDoUpdate({
          target: orgMetadata.orgId,
          set: { defaultAgentId: agentId, updatedAt: new Date() },
        }),
      // Mark onboarding complete
      db
        .insert(orgMembersMetadata)
        .values({
          orgId: org.orgId,
          userId,
          onboardingDone: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: { onboardingDone: true, updatedAt: new Date() },
        }),
    ];

    // Set user connectors if provided
    if (body.selectedConnectors && body.selectedConnectors.length > 0) {
      const connectors = body.selectedConnectors;
      parallelGroup2.push(
        db.transaction(async (tx) => {
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
            connectors.map((connectorType) => {
              return {
                orgId: org.orgId,
                userId,
                agentId,
                connectorType,
              };
            }),
          );
        }),
      );
    }

    await Promise.all(parallelGroup2);

    log.info(`Onboarding setup completed for org ${org.orgId}`, { agentId });

    return {
      status: 200 as const,
      body: { agentId },
    };
  },
});

const handler = createHandler(onboardingSetupContract, router, {
  errorHandler: createSafeErrorHandler("onboarding-setup"),
});

export { handler as POST };
