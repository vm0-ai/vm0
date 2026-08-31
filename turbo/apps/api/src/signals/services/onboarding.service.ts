import { command, computed, type Computed } from "ccstate";
import type { OnboardingStatusResponse } from "@okouai/api-contracts/contracts/onboarding";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentDisplayNameForPublicBrand } from "@okouai/core/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";

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
    .insert(orgMetadataCanonicalWrites)
    .values({
      orgId,
      onboardingComplete: true,
      updatedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgMetadataCanonicalWrites.orgId,
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
  publicBrand: PublicBrand,
): Computed<Promise<DefaultAgentInfo | null>> {
  return computed(async (get): Promise<DefaultAgentInfo | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
      })
      .from(agents)
      .where(and(eq(agents.id, composeId), eq(agents.orgId, orgId)))
      .limit(1);

    if (!row) {
      return null;
    }

    const metadata: DefaultAgentMetadata = {};
    if (row.displayName !== null) {
      metadata.displayName =
        agentDisplayNameForPublicBrand({
          agentId: composeId,
          defaultAgentId: composeId,
          displayName: row.displayName,
          publicBrand,
        }) ?? row.displayName;
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
  publicBrand: PublicBrand,
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
      ? await get(defaultAgentInfo(auth.orgId, agentId, publicBrand))
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
