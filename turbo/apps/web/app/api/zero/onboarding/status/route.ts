import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { isBadRequest, isNotFound } from "../../../../../src/lib/shared/errors";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { eq, and } from "drizzle-orm";
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
}

async function resolveDefaultAgent(
  composeId: string,
): Promise<DefaultAgentInfo | null> {
  // INNER JOIN: both agent_composes and zero_agents must exist.
  // An orphan compose (missing zero_agents row) is treated as non-existent
  // so the admin re-enters full onboarding and creates a complete agent.
  const [row] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
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

  return { name: row.name, composeId, metadata };
}

const router = tsr.router(onboardingStatusContract, {
  getStatus: async ({ headers }) => {
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

    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx);
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
        // defaultAgentId IS the composeId (zero_agents.id = agent_composes.id)
        defaultAgent = await resolveDefaultAgent(defaultAgentId);
      }
    } catch (error) {
      if (!isNotFound(error) && !isBadRequest(error)) {
        throw error;
      }
    }

    let needsOnboarding: boolean;
    if (!hasOrg) {
      needsOnboarding = true;
    } else if (isAdmin && !defaultAgent) {
      // Org needs initial setup — full admin onboarding
      needsOnboarding = true;
    } else {
      // Org is set up — check personal onboarding (applies to both admins and members)
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
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router, {
  errorHandler: createSafeErrorHandler("zero-onboarding-status"),
});

export { handler as GET };
