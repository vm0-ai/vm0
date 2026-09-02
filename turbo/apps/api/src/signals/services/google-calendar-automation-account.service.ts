import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  type GoogleCalendarAutomationEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export const GOOGLE_CALENDAR_EVENT_TYPES = [
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
] as const;

export const GOOGLE_CALENDAR_PRIMARY_ID = "primary";

function parseGoogleCalendarAutomationConfig(
  eventType: string | null,
  eventConfig: unknown,
): GoogleCalendarAutomationEventConfig | null {
  if (eventType === "google-calendar-event-created") {
    const parsed =
      googleCalendarEventCreatedEventConfigSchema.safeParse(eventConfig);
    return parsed.success ? parsed.data : null;
  }
  if (eventType === "google-calendar-event-updated") {
    const parsed =
      googleCalendarEventUpdatedEventConfigSchema.safeParse(eventConfig);
    return parsed.success ? parsed.data : null;
  }
  if (eventType === "google-calendar-event-cancelled") {
    const parsed =
      googleCalendarEventCancelledEventConfigSchema.safeParse(eventConfig);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export async function migrateGoogleCalendarAutomationTargets(
  db: Db,
  args: {
    readonly connectorId: string;
    readonly fromCalendarId: string;
    readonly toCalendarId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.eventConnectorId, args.connectorId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [
          ...GOOGLE_CALENDAR_EVENT_TYPES,
        ]),
      ),
    );
  signal.throwIfAborted();

  const currentTime = nowDate();
  let migrated = 0;
  for (const automation of automations) {
    const config = parseGoogleCalendarAutomationConfig(
      automation.eventType,
      automation.eventConfig,
    );
    if (config === null || config.calendarId !== args.fromCalendarId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({
        eventConfig: { ...config, calendarId: args.toCalendarId },
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
        ),
      );
    signal.throwIfAborted();
    migrated += 1;
  }
  return migrated;
}

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
