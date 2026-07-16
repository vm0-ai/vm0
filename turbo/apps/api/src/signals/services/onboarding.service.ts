import { command, computed, type Computed } from "ccstate";
import type { OnboardingStatusResponse } from "@vm0/api-contracts/contracts/onboarding";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";

interface DefaultAgentInfo {
  readonly composeId: string;
  readonly metadata: OnboardingStatusResponse["defaultAgentMetadata"];
}

type DefaultAgentMetadata = NonNullable<
  OnboardingStatusResponse["defaultAgentMetadata"]
>;

type CompleteOnboardingResponse = {
  readonly status: 200;
  readonly body: {
    readonly onboardingComplete: true;
    readonly needsOnboarding: false;
  };
};

async function markOnboardingComplete(db: Db, orgId: string): Promise<void> {
  await db
    .insert(orgMetadata)
    .values({
      orgId,
      onboardingComplete: true,
      updatedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        onboardingComplete: true,
        updatedAt: nowDate(),
      },
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

function onboardingComplete(orgId: string): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [row] = await db
      .select({ onboardingComplete: orgMetadata.onboardingComplete })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.onboardingComplete ?? false;
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
        avatarUrl: zeroAgents.avatarUrl,
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
    if (row.avatarUrl !== null) {
      metadata.avatarUrl = row.avatarUrl;
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
      const isAdmin = false;
      const complete = false;
      return {
        needsOnboarding: isAdmin && !complete,
        onboardingComplete: complete,
        isAdmin,
        hasOrg: false,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      };
    }

    const isAdmin = "orgRole" in auth && auth.orgRole === "admin";
    const agentId = await get(defaultAgentId(auth.orgId));
    const complete = await get(onboardingComplete(auth.orgId));
    const defaultAgent = agentId
      ? await get(defaultAgentInfo(auth.orgId, agentId))
      : null;

    return {
      needsOnboarding: isAdmin && !complete,
      onboardingComplete: complete,
      isAdmin,
      hasOrg: true,
      hasDefaultAgent: defaultAgent !== null,
      defaultAgentId: defaultAgent?.composeId ?? null,
      defaultAgentMetadata: defaultAgent?.metadata ?? null,
    };
  });
}

export const completeOnboarding$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<CompleteOnboardingResponse> => {
    const writeDb = set(writeDb$);
    await markOnboardingComplete(writeDb, args.orgId);
    signal.throwIfAborted();

    return {
      status: 200,
      body: {
        onboardingComplete: true,
        needsOnboarding: false,
      },
    };
  },
);
