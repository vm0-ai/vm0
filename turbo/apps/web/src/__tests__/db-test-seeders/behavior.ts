import { and, eq } from "drizzle-orm";
import { userBehaviorCount } from "../../db/schema/user-behavior-count";

/**
 * Seed a user behavior count row for testing.
 * @why-db-direct Behavior counts have no direct write API — production writes
 *   flow through specific feature routes (e.g., POST /voice-io/stt) that would
 *   require mocking multiple external dependencies just to populate state.
 */
export async function seedBehaviorCount(
  orgId: string,
  userId: string,
  behaviorKey: string,
  count: number,
): Promise<void> {
  const now = new Date();
  await globalThis.services.db
    .insert(userBehaviorCount)
    .values({ orgId, userId, behaviorKey, count, firstAt: now, lastAt: now })
    .onConflictDoUpdate({
      target: [
        userBehaviorCount.orgId,
        userBehaviorCount.userId,
        userBehaviorCount.behaviorKey,
      ],
      set: { count, lastAt: now },
    });
}

/**
 * Read the current behavior count for test assertions.
 * @why-db-direct getCount service cannot be imported in test files per
 *   web/no-direct-db-in-tests; this helper encapsulates the DB read.
 */
export async function readBehaviorCount(
  orgId: string,
  userId: string,
  behaviorKey: string,
): Promise<number> {
  const rows = await globalThis.services.db
    .select({ count: userBehaviorCount.count })
    .from(userBehaviorCount)
    .where(
      and(
        eq(userBehaviorCount.orgId, orgId),
        eq(userBehaviorCount.userId, userId),
        eq(userBehaviorCount.behaviorKey, behaviorKey),
      ),
    );
  return rows[0]?.count ?? 0;
}
