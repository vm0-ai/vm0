import { computed, type Computed } from "ccstate";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

export function userFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Computed<Promise<Record<string, boolean>>> {
  return computed(async (get): Promise<Record<string, boolean>> => {
    const db = get(db$);
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
  });
}
