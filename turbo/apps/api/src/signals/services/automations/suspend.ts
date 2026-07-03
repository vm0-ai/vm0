import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../../external/db";
import { nowDate } from "../../external/time";

const TIME_TRIGGER_KINDS = ["cron", "once", "loop"] as const;

export async function suspendOrgMemberAutomations(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const suspendedAt = nowDate();
  const automationIds = db
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    );

  await db
    .update(automations)
    .set({ enabled: false, updatedAt: suspendedAt })
    .where(
      and(
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    );

  await db
    .update(automationTriggers)
    .set({ enabled: false, nextRunAt: null, updatedAt: suspendedAt })
    .where(
      and(
        inArray(automationTriggers.automationId, automationIds),
        inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
      ),
    );
}
