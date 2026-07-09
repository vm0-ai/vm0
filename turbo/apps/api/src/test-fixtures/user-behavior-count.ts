/**
 * In-process test fixture for `user_behavior_count` quota counters.
 *
 * Behavior counters (voice-io lifetime/daily quota state) have no product
 * API for construction — the only production writer is the STT flow itself,
 * one increment per transcription. Driving a counter to its limit through
 * the product path would require hundreds of requests (pro daily rate limit
 * is 300) or hours of audio (duration limits are metered from real WAV
 * bytes), so this module is the narrow test-boundary exception: it only
 * upserts a counter to a given value. Assertions on counters stay on product
 * surfaces (quota responses and limit errors).
 */
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { createStore } from "ccstate";
import { sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function seedUserBehaviorCount(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly behaviorKey: string;
  readonly count: number;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .insert(userBehaviorCount)
    .values(values)
    .onConflictDoUpdate({
      target: [
        userBehaviorCount.orgId,
        userBehaviorCount.userId,
        userBehaviorCount.behaviorKey,
      ],
      set: { count: values.count, lastAt: sql`now()` },
    });
}
