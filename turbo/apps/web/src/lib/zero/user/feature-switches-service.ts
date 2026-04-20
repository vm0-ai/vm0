import { eq, and } from "drizzle-orm";
import { FeatureSwitchKey } from "@vm0/core";
import { userFeatureSwitches } from "../../../db/schema/user-feature-switches";

/**
 * Get user feature switch overrides for the given org + user.
 * Returns empty object if no record exists.
 */
export async function getUserFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<Record<string, boolean>> {
  const db = globalThis.services.db;

  const [row] = await db
    .select()
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);

  return row ? (row.switches as Record<string, boolean>) : {};
}

/**
 * Load per-user feature switch overrides from the database.
 * Returns undefined if orgId/userId is missing or no overrides exist.
 */
export async function loadFeatureSwitchOverrides(
  orgId: string | undefined,
  userId: string | undefined,
): Promise<Partial<Record<FeatureSwitchKey, boolean>> | undefined> {
  if (!orgId || !userId) return undefined;
  const switches = await getUserFeatureSwitches(orgId, userId);
  return Object.keys(switches).length > 0
    ? (switches as Partial<Record<FeatureSwitchKey, boolean>>)
    : undefined;
}

/**
 * Update user feature switch overrides with merge strategy.
 * Merges the provided switches with existing ones (shallow merge).
 */
export async function updateUserFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Record<string, boolean>,
): Promise<Record<string, boolean>> {
  const db = globalThis.services.db;

  const existing = await getUserFeatureSwitches(orgId, userId);
  const merged = { ...existing, ...switches };
  const now = new Date();

  await db
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: merged,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: merged,
        updatedAt: now,
      },
    });

  return merged;
}
