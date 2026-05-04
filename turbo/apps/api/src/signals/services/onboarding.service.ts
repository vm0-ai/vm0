import { computed, type Computed } from "ccstate";
import type { OnboardingStatusResponse } from "@vm0/api-contracts/contracts/onboarding";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { db$ } from "../external/db";

interface DefaultAgentInfo {
  readonly composeId: string;
  readonly metadata: OnboardingStatusResponse["defaultAgentMetadata"];
}

type DefaultAgentMetadata = NonNullable<
  OnboardingStatusResponse["defaultAgentMetadata"]
>;

function memberOnboardingDone(
  orgId: string,
  userId: string,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [row] = await db
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
  });
}

function defaultAgentId(orgId: string): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.defaultAgentId ?? null;
  });
}

function defaultAgentInfo(
  orgId: string,
  composeId: string,
): Computed<Promise<DefaultAgentInfo | null>> {
  return computed(async (get): Promise<DefaultAgentInfo | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(agentComposes)
      .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(eq(agentComposes.id, composeId), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    const metadata: DefaultAgentMetadata = {};
    if (row.displayName !== null) {
      metadata.displayName = row.displayName;
    }
    if (row.description !== null) {
      metadata.description = row.description;
    }
    if (row.sound !== null) {
      metadata.sound = row.sound;
    }

    return {
      composeId,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    };
  });
}

export function onboardingStatus(
  auth: AuthContext,
): Computed<Promise<OnboardingStatusResponse>> {
  return computed(async (get): Promise<OnboardingStatusResponse> => {
    if (!auth.orgId) {
      return {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: false,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      };
    }

    const isAdmin = "orgRole" in auth && auth.orgRole === "admin";
    const agentId = await get(defaultAgentId(auth.orgId));
    const defaultAgent = agentId
      ? await get(defaultAgentInfo(auth.orgId, agentId))
      : null;

    const shouldReadMemberOnboarding = Boolean(defaultAgent) || !isAdmin;
    const onboardingDone = shouldReadMemberOnboarding
      ? await get(memberOnboardingDone(auth.orgId, auth.userId))
      : false;

    return {
      needsOnboarding: isAdmin && !defaultAgent ? true : !onboardingDone,
      isAdmin,
      hasOrg: true,
      hasDefaultAgent: defaultAgent !== null,
      defaultAgentId: defaultAgent?.composeId ?? null,
      defaultAgentMetadata: defaultAgent?.metadata ?? null,
    };
  });
}
