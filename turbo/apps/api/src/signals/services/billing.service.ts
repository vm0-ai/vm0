import { computed, type Computed } from "ccstate";
import type { AutoRechargeConfig } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db$ } from "../external/db";

export function autoRechargeConfig(
  orgId: string,
): Computed<Promise<AutoRechargeConfig>> {
  return computed(async (get): Promise<AutoRechargeConfig> => {
    const db = get(db$);
    const [row] = await db
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return {
      enabled: row?.autoRechargeEnabled ?? false,
      threshold: row?.autoRechargeThreshold ?? null,
      amount: row?.autoRechargeAmount ?? null,
    };
  });
}
