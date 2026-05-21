import { eq, and } from "drizzle-orm";
import type { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { initServices } from "../../init-services";

function getDb() {
  initServices();
  return globalThis.services.db;
}

/**
 * Get user feature switch overrides for the given org + user.
 * Returns empty object if no record exists.
 */
async function getUserFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<Record<string, boolean>> {
  const db = getDb();

  const [row] = await db
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);

  return row?.switches ?? {};
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
  return Object.keys(switches).length > 0 ? switches : undefined;
}
