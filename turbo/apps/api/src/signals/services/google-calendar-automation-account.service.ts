import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export const GOOGLE_CALENDAR_EVENT_TYPES = [
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
] as const;

export async function resolveGoogleCalendarAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-calendar",
  });
}

export async function reprojectGoogleCalendarAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [
          ...GOOGLE_CALENDAR_EVENT_TYPES,
        ]),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveGoogleCalendarAutomationConnectorId(
      db,
      {
        ...args,
        workflowId: automation.workflowId,
      },
    );
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(eq(workflowAutomations.id, automation.id));
  }
}
