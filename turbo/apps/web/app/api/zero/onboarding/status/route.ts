import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { isBadRequest, isNotFound } from "../../../../../src/lib/errors";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { eq, and } from "drizzle-orm";
import { resolveComposeIdFromAgentId } from "../../../../../src/lib/zero/resolve-default-agent";
import { agentComposeApiContentSchema } from "@vm0/core";
import { orgMembersMetadata } from "../../../../../src/db/schema/org-members-metadata";
import { orgMetadata as orgTable } from "../../../../../src/db/schema/org-metadata";

async function isMemberOnboardingDone(
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await globalThis.services.db
    .select({ onboardingDone: orgMembersMetadata.onboardingDone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  return row?.onboardingDone ?? false;
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
  // Single query: JOIN compose + zero_agents + head version
  const [row] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      content: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      zeroAgents,
      and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, agentComposes.name)),
    )
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!row) {
    return null;
  }

  const metadata =
    (row.displayName ?? row.description ?? row.sound)
      ? {
          displayName: row.displayName ?? undefined,
          description: row.description ?? undefined,
          sound: row.sound ?? undefined,
        }
      : null;

  let skills: string[] = [];
  if (row.content) {
    const parsed = agentComposeApiContentSchema.safeParse(row.content);
    if (parsed.success) {
      const agentKey = Object.keys(parsed.data.agents)[0];
      const agentDef = agentKey ? parsed.data.agents[agentKey] : undefined;
      if (agentDef) {
        skills = agentDef.skills ?? [];
      }
    }
  }

  return { name: row.name, composeId, metadata, skills };
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
    let defaultAgent: DefaultAgentInfo | null = null;
    let isAdmin = false;

    const orgSlug = new URL(request.url).searchParams.get("org");
    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx, orgSlug);
      hasOrg = true;
      resolvedOrgId = resolvedOrg.orgId;
      isAdmin = member.role === "admin";

      // Read default agent ID (zero agent UUID) from org table
      const [orgRow] = await globalThis.services.db
        .select({ defaultAgentId: orgTable.defaultAgentId })
        .from(orgTable)
        .where(eq(orgTable.orgId, resolvedOrg.orgId))
        .limit(1);
      const defaultAgentId = orgRow?.defaultAgentId ?? null;

      if (defaultAgentId) {
        // Resolve zero agent UUID → compose UUID for backward-compatible response
        const composeId = await resolveComposeIdFromAgentId(defaultAgentId);
        if (composeId) {
          defaultAgent = await resolveDefaultAgent(
            resolvedOrg.orgId,
            composeId,
          );
        }
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
        hasDefaultAgent: defaultAgent !== null,
        defaultAgentId: defaultAgent?.composeId ?? null,
        defaultAgentMetadata: defaultAgent?.metadata ?? null,
        defaultAgentSkills: defaultAgent?.skills ?? [],
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router, {
  errorHandler: createSafeErrorHandler("zero-onboarding-status"),
});

export { handler as GET };
