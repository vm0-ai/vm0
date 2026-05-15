import { and, eq, sql } from "drizzle-orm";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";

export async function recordBehavior(
  orgId: string,
  userId: string,
  behaviorKey: string,
  increment = 1,
): Promise<number> {
  const db = globalThis.services.db;
  const [row] = await db
    .insert(userBehaviorCount)
    .values({
      orgId,
      userId,
      behaviorKey,
      count: increment,
    })
    .onConflictDoUpdate({
      target: [
        userBehaviorCount.orgId,
        userBehaviorCount.userId,
        userBehaviorCount.behaviorKey,
      ],
      set: {
        count: sql`${userBehaviorCount.count} + ${increment}`,
        lastAt: sql`now()`,
      },
    })
    .returning({ count: userBehaviorCount.count });
  if (!row) {
    throw new Error("recordBehavior upsert did not return a row");
  }
  return row.count;
}

export async function getCount(
  orgId: string,
  userId: string,
  behaviorKey: string,
): Promise<number> {
  const db = globalThis.services.db;
  const [row] = await db
    .select({ count: userBehaviorCount.count })
    .from(userBehaviorCount)
    .where(
      and(
        eq(userBehaviorCount.orgId, orgId),
        eq(userBehaviorCount.userId, userId),
        eq(userBehaviorCount.behaviorKey, behaviorKey),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

export async function hasDone(
  orgId: string,
  userId: string,
  behaviorKey: string,
): Promise<boolean> {
  return (await getCount(orgId, userId, behaviorKey)) > 0;
}
