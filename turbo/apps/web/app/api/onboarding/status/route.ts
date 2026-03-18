import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isBadRequest, isNotFound } from "../../../../src/lib/errors";
import { modelProviders } from "../../../../src/db/schema/model-provider";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { eq, and, or } from "drizzle-orm";
import { ORG_SENTINEL_USER_ID } from "../../../../src/lib/org/org-sentinel";
import { agentComposeApiContentSchema } from "@vm0/core";
import { clerkClient } from "@clerk/nextjs/server";
import { orgMembersCache } from "../../../../src/db/schema/org-members-cache";
import { z } from "zod";

const memberPublicMetadataSchema = z
  .object({ onboarding_done: z.boolean().optional() })
  .optional();

async function isMemberOnboardingDone(
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [cached] = await globalThis.services.db
    .select({ onboardingDone: orgMembersCache.onboardingDone })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);

  if (cached) {
    return cached.onboardingDone;
  }

  // Cache miss — read from Clerk API
  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
  });
  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === userId,
  );
  const metadata = memberPublicMetadataSchema.parse(membership?.publicMetadata);
  return metadata?.onboarding_done === true;
}

const router = tsr.router(onboardingStatusContract, {
  getStatus: async ({ headers }, { request }) => {
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

    // Check if org exists
    let hasOrg = false;
    let resolvedOrgId: string | null = null;
    let hasModelProvider = false;
    let hasDefaultAgent = false;
    let defaultAgentName: string | null = null;
    let defaultAgentComposeId: string | null = null;
    let defaultAgentMetadata: {
      displayName?: string;
      description?: string;
      sound?: string;
    } | null = null;
    let defaultAgentSkills: string[] = [];

    let isAdmin = false;

    const orgSlug = new URL(request.url).searchParams.get("org");
    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx, orgSlug);
      hasOrg = true;
      resolvedOrgId = resolvedOrg.orgId;
      isAdmin = member.role === "admin";

      // Check model provider for this user or org-level (matches runtime fallback in build-context.ts)
      const [provider] = await globalThis.services.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, resolvedOrg.orgId),
            or(
              eq(modelProviders.userId, authCtx.userId),
              eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
            ),
          ),
        )
        .limit(1);

      hasModelProvider = provider !== undefined;

      // Read default agent compose ID from Clerk JWT session claims
      const claimAgentComposeId =
        authCtx.sessionClaims?.org_default_agent_compose_id ?? null;

      if (claimAgentComposeId) {
        const [compose] = await globalThis.services.db
          .select({
            name: agentComposes.name,
            headVersionId: agentComposes.headVersionId,
            content: agentComposeVersions.content,
          })
          .from(agentComposes)
          .leftJoin(
            agentComposeVersions,
            eq(agentComposes.headVersionId, agentComposeVersions.id),
          )
          .where(eq(agentComposes.id, claimAgentComposeId))
          .limit(1);

        if (compose) {
          hasDefaultAgent = true;
          defaultAgentName = compose.name;
          defaultAgentComposeId = claimAgentComposeId;

          // Extract metadata from compose content
          const parsed = agentComposeApiContentSchema.safeParse(
            compose.content,
          );
          if (parsed.success) {
            const agentKey = Object.keys(parsed.data.agents)[0];
            const agentDef = agentKey
              ? parsed.data.agents[agentKey]
              : undefined;
            if (agentDef) {
              defaultAgentMetadata = agentDef.metadata ?? null;
              defaultAgentSkills = agentDef.skills ?? [];
            }
          }
        }
      }
    } catch (error) {
      if (!isNotFound(error) && !isBadRequest(error)) {
        throw error;
      }
      // Org not found or no explicit org context — all flags stay false
    }

    // Admins need onboarding when org setup is incomplete.
    // Members need onboarding when they haven't completed the member welcome flow
    // (tracked via Clerk membership metadata `onboarding_done`).
    let needsOnboarding: boolean;
    if (!hasOrg) {
      needsOnboarding = true;
    } else if (isAdmin) {
      needsOnboarding = !hasModelProvider || !hasDefaultAgent;
    } else {
      // resolvedOrgId is set whenever hasOrg is true (both come from the same try block)
      if (!resolvedOrgId) {
        throw new Error("resolvedOrgId is null despite hasOrg being true");
      }
      // Read onboarding_done from org_members_cache first, fall back to Clerk API.
      const onboardingDone = await isMemberOnboardingDone(
        resolvedOrgId,
        authCtx.userId,
      );
      needsOnboarding = !onboardingDone;
    }

    return {
      status: 200 as const,
      body: {
        needsOnboarding,
        isAdmin,
        hasOrg,
        hasModelProvider,
        hasDefaultAgent,
        defaultAgentName,
        defaultAgentComposeId,
        defaultAgentMetadata,
        defaultAgentSkills,
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router);

export { handler as GET };
