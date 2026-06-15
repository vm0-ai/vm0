import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

export const processStaleUsageEvents$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const orgs = await db
      .selectDistinct({ orgId: usageEvent.orgId })
      .from(usageEvent)
      .where(eq(usageEvent.status, "pending"));
    signal.throwIfAborted();

    for (const { orgId } of orgs) {
      await set(processOrgUsageEvents$, orgId, signal);
      signal.throwIfAborted();
    }

    return orgs.length;
  },
);
