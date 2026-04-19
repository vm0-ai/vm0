import { userFeatureSwitches } from "../../db/schema/user-feature-switches";

/**
 * Seed user feature switch overrides for testing.
 * @why-db-direct Feature switch overrides have no user-facing API in tests;
 *   the admin API requires an authenticated session which is not available here.
 */
export async function seedUserFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Record<string, boolean>,
): Promise<void> {
  await globalThis.services.db
    .insert(userFeatureSwitches)
    .values({ orgId, userId, switches, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches, updatedAt: new Date() },
    });
}
