import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
} from "@vm0/api-contracts/contracts/zero-workflows";

import type { Db } from "../external/db";
import { reconcileGmailWatchesForUser } from "./gmail-workflow-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "./google-calendar-workflow-event.service";

interface WorkflowEventWatchAutomation {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
}

type WorkflowEventWatchTarget =
  | {
      readonly provider: "gmail";
      readonly orgId: string;
      readonly userId: string;
    }
  | {
      readonly provider: "google_calendar";
      readonly orgId: string;
      readonly userId: string;
      readonly calendarId: string;
    };

function googleCalendarId(
  automation: WorkflowEventWatchAutomation,
): string | null {
  if (automation.eventType === "google-calendar-event-created") {
    const config = googleCalendarEventCreatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  if (automation.eventType === "google-calendar-event-updated") {
    const config = googleCalendarEventUpdatedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    const config = googleCalendarEventCancelledEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    return config.success ? config.data.calendarId : null;
  }
  return null;
}

function workflowEventWatchTarget(
  automation: WorkflowEventWatchAutomation,
): WorkflowEventWatchTarget | null {
  if (
    automation.eventType === "gmail-new-message" ||
    automation.eventType === "gmail-label-applied"
  ) {
    return {
      provider: "gmail",
      orgId: automation.orgId,
      userId: automation.ownerUserId,
    };
  }
  const calendarId = googleCalendarId(automation);
  if (calendarId === null) {
    return null;
  }
  return {
    provider: "google_calendar",
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    calendarId,
  };
}

function targetKey(target: WorkflowEventWatchTarget): string {
  return target.provider === "gmail"
    ? `gmail:${target.orgId}:${target.userId}`
    : `google_calendar:${target.orgId}:${target.userId}:${target.calendarId}`;
}

export async function reconcileWorkflowEventWatches(args: {
  readonly db: Db;
  readonly automations: readonly WorkflowEventWatchAutomation[];
  readonly signal: AbortSignal;
}): Promise<void> {
  const targets = new Map<string, WorkflowEventWatchTarget>();
  for (const automation of args.automations) {
    const target = workflowEventWatchTarget(automation);
    if (target) {
      targets.set(targetKey(target), target);
    }
  }

  for (const target of targets.values()) {
    if (target.provider === "gmail") {
      await reconcileGmailWatchesForUser({
        db: args.db,
        orgId: target.orgId,
        userId: target.userId,
        signal: args.signal,
      });
      continue;
    }
    await reconcileGoogleCalendarWatchesForUser({
      db: args.db,
      orgId: target.orgId,
      userId: target.userId,
      calendarId: target.calendarId,
      signal: args.signal,
    });
  }
}
