import { computed, type Computed } from "ccstate";
import { orgTierSchema, type OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { AudioInputQuotaResponse } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

const AUDIO_INPUT_FREE_QUOTA = 10;
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

function orgTier(orgId: string): Computed<Promise<OrgTier>> {
  return computed(async (get): Promise<OrgTier> => {
    const db = get(db$);
    const [row] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return orgTierSchema.parse(row?.tier ?? "pro-suspend");
  });
}

function audioInputCount(
  orgId: string,
  userId: string,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const db = get(db$);
    const [row] = await db
      .select({ count: userBehaviorCount.count })
      .from(userBehaviorCount)
      .where(
        and(
          eq(userBehaviorCount.orgId, orgId),
          eq(userBehaviorCount.userId, userId),
          eq(userBehaviorCount.behaviorKey, AUDIO_INPUT_BEHAVIOR_KEY),
        ),
      )
      .limit(1);

    return row?.count ?? 0;
  });
}

export function audioInputQuota(
  orgId: string,
  userId: string,
): Computed<Promise<AudioInputQuotaResponse>> {
  return computed(async (get): Promise<AudioInputQuotaResponse> => {
    const tier = await get(orgTier(orgId));
    if (tier === "pro" || tier === "team") {
      return { allowed: true, count: 0, limit: null };
    }

    const count = await get(audioInputCount(orgId, userId));
    const limit = tier === "pro-suspend" ? 0 : AUDIO_INPUT_FREE_QUOTA;
    return {
      allowed: count < limit,
      count,
      limit,
    };
  });
}
