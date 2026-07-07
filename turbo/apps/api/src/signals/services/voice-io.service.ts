import { computed, type Computed } from "ccstate";
import { orgTierSchema, type OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { AudioInputQuotaResponse } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  AUDIO_INPUT_FREE_QUOTA,
  DAILY_DURATION_LIMITS,
  DAILY_RATE_LIMITS,
  sttDailyDurationKey,
  sttDailyRateKey,
} from "./voice-io-limits";

function blockedQuota(count: number, limit: number): AudioInputQuotaResponse {
  return { allowed: false, count, limit };
}

function lifetimeQuotaForTier(
  tier: OrgTier,
  count: number,
): AudioInputQuotaResponse {
  if (tier === "pro" || tier === "team") {
    return { allowed: true, count: 0, limit: null };
  }

  const limit = tier === "pro-suspend" ? 0 : AUDIO_INPUT_FREE_QUOTA;
  return {
    allowed: count < limit,
    count,
    limit,
  };
}

export function audioInputLifetimeQuota(
  orgId: string,
  userId: string,
): Computed<Promise<AudioInputQuotaResponse>> {
  return computed(async (get): Promise<AudioInputQuotaResponse> => {
    const db = get(db$);
    const [orgRow] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const tier: OrgTier = orgTierSchema.parse(orgRow?.tier ?? "pro-suspend");

    if (tier === "pro" || tier === "team") {
      return lifetimeQuotaForTier(tier, 0);
    }

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

    return lifetimeQuotaForTier(tier, row?.count ?? 0);
  });
}

export function audioInputQuota(
  orgId: string,
  userId: string,
): Computed<Promise<AudioInputQuotaResponse>> {
  return computed(async (get): Promise<AudioInputQuotaResponse> => {
    const db = get(db$);
    const today = nowDate();
    const rateKey = sttDailyRateKey(today);
    const durationKey = sttDailyDurationKey(today);

    const [orgRow] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const tier: OrgTier = orgTierSchema.parse(orgRow?.tier ?? "pro-suspend");

    const behaviorRows = await db
      .select({
        key: userBehaviorCount.behaviorKey,
        count: userBehaviorCount.count,
      })
      .from(userBehaviorCount)
      .where(
        and(
          eq(userBehaviorCount.orgId, orgId),
          eq(userBehaviorCount.userId, userId),
          inArray(userBehaviorCount.behaviorKey, [
            AUDIO_INPUT_BEHAVIOR_KEY,
            rateKey,
            durationKey,
          ]),
        ),
      );
    const counts = new Map(
      behaviorRows.map((row): readonly [string, number] => {
        return [row.key, row.count];
      }),
    );

    const rateCount = counts.get(rateKey) ?? 0;
    const rateLimit = DAILY_RATE_LIMITS[tier];
    if (rateCount >= rateLimit) {
      return blockedQuota(rateCount, rateLimit);
    }

    const durationCount = counts.get(durationKey) ?? 0;
    const durationLimit = DAILY_DURATION_LIMITS[tier];
    if (durationCount >= durationLimit) {
      return blockedQuota(durationCount, durationLimit);
    }

    const count = counts.get(AUDIO_INPUT_BEHAVIOR_KEY) ?? 0;
    return lifetimeQuotaForTier(tier, count);
  });
}
