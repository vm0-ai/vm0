import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

export const processStaleUsageEvents$ = command(
  async (
    { set },
    orgId: string | undefined,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const orgs = await db
      .selectDistinct({ orgId: usageEvent.orgId })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.status, "pending"),
          orgId === undefined ? undefined : eq(usageEvent.orgId, orgId),
        ),
      );
    signal.throwIfAborted();

    for (const { orgId: pendingOrgId } of orgs) {
      await set(processOrgUsageEvents$, pendingOrgId, signal);
      signal.throwIfAborted();
    }

    return orgs.length;
  },
);
