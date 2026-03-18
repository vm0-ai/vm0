import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isBadRequest, isNotFound } from "../../../../src/lib/errors";
import { modelProviders } from "../../../../src/db/schema/model-provider";
import { ORG_SENTINEL_USER_ID } from "../../../../src/lib/org/org-sentinel";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { eq, and } from "drizzle-orm";
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

interface DefaultAgentInfo {
  name: string;
  composeId: string;
  metadata: {
    displayName?: string;
    description?: string;
    sound?: string;
  } | null;
  skills: string[];
}

async function resolveDefaultAgent(
  orgId: string,
  composeId: string,
): Promise<DefaultAgentInfo | null> {
  const [compose] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    return null;
  }

  // Read metadata from zero_agents table
  const [agent] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, compose.name)))
    .limit(1);

  const metadata = agent
    ? {
        displayName: agent.displayName ?? undefined,
        description: agent.description ?? undefined,
        sound: agent.sound ?? undefined,
      }
    : null;

  // Extract skills from compose content (still in JSONB)
  let skills: string[] = [];
  if (compose.headVersionId) {
    const [version] = await globalThis.services.db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);
    if (version) {
      const parsed = agentComposeApiContentSchema.safeParse(version.content);
      if (parsed.success) {
        const agentKey = Object.keys(parsed.data.agents)[0];
        const agentDef = agentKey ? parsed.data.agents[agentKey] : undefined;
        if (agentDef) {
          skills = agentDef.skills ?? [];
        }
      }
    }
  }

  return { name: compose.name, composeId, metadata, skills };
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

    let hasOrg = false;
    let resolvedOrgId: string | null = null;
    let hasModelProvider = false;
    let defaultAgent: DefaultAgentInfo | null = null;
    let isAdmin = false;

    const orgSlug = new URL(request.url).searchParams.get("org");
    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx, orgSlug);
      hasOrg = true;
      resolvedOrgId = resolvedOrg.orgId;
      isAdmin = member.role === "admin";

      // Check if the org has an org-level model provider configured
      const [provider] = await globalThis.services.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, resolvedOrg.orgId),
            eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          ),
        )
        .limit(1);

      hasModelProvider = provider !== undefined;

      // Read default agent compose ID from Clerk JWT session claims
      const claimAgentComposeId =
        authCtx.sessionClaims?.org_default_agent_compose_id ?? null;

      if (claimAgentComposeId) {
        defaultAgent = await resolveDefaultAgent(
          resolvedOrg.orgId,
          claimAgentComposeId,
        );
      }
    } catch (error) {
      if (!isNotFound(error) && !isBadRequest(error)) {
        throw error;
      }
    }

    let needsOnboarding: boolean;
    if (!hasOrg) {
      needsOnboarding = true;
    } else if (isAdmin) {
      needsOnboarding = !defaultAgent;
    } else {
      if (!resolvedOrgId) {
        throw new Error("resolvedOrgId is null despite hasOrg being true");
      }
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
        hasDefaultAgent: defaultAgent !== null,
        defaultAgentName: defaultAgent?.name ?? null,
        defaultAgentComposeId: defaultAgent?.composeId ?? null,
        defaultAgentMetadata: defaultAgent?.metadata ?? null,
        defaultAgentSkills: defaultAgent?.skills ?? [],
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router);

export { handler as GET };
