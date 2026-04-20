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
import { clerkClient } from "@clerk/nextjs/server";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { upsertOrgNoSecretModelProvider } from "../../../../../src/lib/zero/model-provider/model-provider-service";
import { serverSideCompose } from "../../../../../src/lib/infra/compose/server-side-compose";
import { buildComposeContent } from "../../../../../src/lib/zero/build-compose-content";
import { SEED_INSTRUCTIONS } from "../../../../../src/lib/zero/seed-instructions";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { orgMembersMetadata } from "../../../../../src/db/schema/org-members-metadata";
import { userConnectors } from "../../../../../src/db/schema/user-connector";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:onboarding-setup");

/**
 * Generate a URL-safe slug from a workspace name.
 */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Check whether a Clerk API error indicates a slug conflict.
 *
 * ClerkAPIResponseError stores the HTTP statusText in `error.message`
 * (e.g. "Unprocessable Entity"), while the actual error details live in
 * the `error.errors` array.  We inspect that array for slug-specific
 * codes / metadata so the retry logic works correctly.
 */
function isClerkSlugConflict(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("errors" in error)) {
    return false;
  }
  const { errors } = error as {
    errors: Array<{
      code?: string;
      message?: string;
      meta?: { paramName?: string };
    }>;
  };
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    return (
      e.code === "form_identifier_exists" ||
      e.meta?.paramName === "slug" ||
      (e.message &&
        (e.message.includes("already exists") || e.message.includes("slug")))
    );
  });
}

/**
 * Update org name and slug via a single Clerk call.
 * Retries once with a random suffix if the slug conflicts.
 */
async function updateOrgNameAndSlug(
  orgId: string,
  workspaceName: string,
): Promise<void> {
  const name = workspaceName.trim();
  if (!name) return;

  const client = await clerkClient();
  const baseSlug = nameToSlug(name);

  // Non-Latin names produce empty slugs — update name only, let Clerk keep existing slug
  if (!baseSlug) {
    await client.organizations.updateOrganization(orgId, { name });
    return;
  }

  const slugCandidates = [
    baseSlug,
    `${baseSlug.slice(0, 56)}-${Math.random().toString(36).slice(2, 8)}`,
  ].filter((s) => {
    return s.length >= 3;
  });

  for (const slug of slugCandidates) {
    try {
      await client.organizations.updateOrganization(orgId, { name, slug });
      return;
    } catch (error: unknown) {
      if (isClerkSlugConflict(error)) continue;
      throw error;
    }
  }

  // Both slug attempts conflicted — update name only
  await client.organizations.updateOrganization(orgId, { name });
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
        status: 403 as const,
        body: {
          error: {
            message: "Only org admins can run onboarding setup",
            code: "FORBIDDEN",
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

    // Parallel: model provider + compose + org name/slug update
    const agentName = crypto.randomUUID();
    const content = buildComposeContent(agentName);

    const [, composeResult] = await Promise.all([
      upsertOrgNoSecretModelProvider(org.orgId, "vm0", "claude-sonnet-4-6"),
      serverSideCompose({
        userId,
        orgId: org.orgId,
        content,
        instructions: SEED_INSTRUCTIONS,
      }),
      body.workspaceName?.trim()
        ? updateOrgNameAndSlug(org.orgId, body.workspaceName).catch(
            (error: unknown) => {
              log.warn("Failed to update org name/slug (non-blocking)", {
                orgId: org.orgId,
                error,
              });
            },
          )
        : Promise.resolve(),
    ]);

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
      // Mark onboarding complete + set timezone from browser
      db
        .insert(orgMembersMetadata)
        .values({
          orgId: org.orgId,
          userId,
          onboardingDone: true,
          timezone: body.timezone ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: {
            onboardingDone: true,
            updatedAt: new Date(),
          },
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
