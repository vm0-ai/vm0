import { and, eq } from "drizzle-orm";
import type { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { initServices } from "../../../src/lib/init-services";

type FeatureSwitchOverrides = Partial<Record<FeatureSwitchKey, boolean>>;

export async function loadDocsFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Promise<FeatureSwitchOverrides | undefined> {
  initServices();

  const [row] = await globalThis.services.db
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);

  const switches = row?.switches;
  return switches && Object.keys(switches).length > 0 ? switches : undefined;
}
