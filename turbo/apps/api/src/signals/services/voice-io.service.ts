import { computed, type Computed } from "ccstate";
import type { AudioInputQuotaResponse } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  sttDailyDurationKey,
  sttDailyRateKey,
} from "./voice-io-limits";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

function blockedQuota(count: number, limit: number): AudioInputQuotaResponse {
  return { allowed: false, count, limit };
}

function lifetimeQuota(
  limit: number | null,
  count: number,
): AudioInputQuotaResponse {
  if (limit === null) {
    return { allowed: true, count: 0, limit: null };
  }

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
    const capabilities = await loadOrgPlanCapabilities(db, orgId);
    const lifetimeLimit = capabilities ? capabilities.audioLifetimeLimit : 0;

    if (lifetimeLimit === null) {
      return lifetimeQuota(lifetimeLimit, 0);
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

    return lifetimeQuota(lifetimeLimit, row?.count ?? 0);
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

    const capabilities = await loadOrgPlanCapabilities(db, orgId);
    const lifetimeLimit = capabilities ? capabilities.audioLifetimeLimit : 0;
    const rateLimit = capabilities?.audioDailyRateLimit ?? 0;
    const durationLimit = capabilities?.audioDailyDurationSeconds ?? 0;

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
    if (rateCount >= rateLimit) {
      return blockedQuota(rateCount, rateLimit);
    }

    const durationCount = counts.get(durationKey) ?? 0;
    if (durationCount >= durationLimit) {
      return blockedQuota(durationCount, durationLimit);
    }

    const count = counts.get(AUDIO_INPUT_BEHAVIOR_KEY) ?? 0;
    return lifetimeQuota(lifetimeLimit, count);
  });
}
