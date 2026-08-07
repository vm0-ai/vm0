import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
} from "@vm0/api-contracts/contracts/zero-workflows";

import type { Db } from "../external/db";
import { reconcileGmailWatchesForUser } from "./gmail-workflow-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "./google-calendar-workflow-event.service";
import { reconcileGoogleFormsWatchesForUser } from "./google-forms-workflow-event.service";

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
    }
  | {
      readonly provider: "google_forms";
      readonly orgId: string;
      readonly userId: string;
      readonly formId: string;
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
  if (automation.eventType === "google-forms-response-submitted") {
    const config = googleFormsResponseSubmittedEventConfigSchema.safeParse(
      automation.eventConfig,
    );
    if (!config.success) {
      return null;
    }
    return {
      provider: "google_forms",
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      formId: config.data.form.id,
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
  if (target.provider === "gmail") {
    return `gmail:${target.orgId}:${target.userId}`;
  }
  if (target.provider === "google_forms") {
    return `google_forms:${target.userId}:${target.formId}`;
  }
  return `google_calendar:${target.orgId}:${target.userId}:${target.calendarId}`;
}

export async function reconcileWorkflowEventWatches(
  args: {
    readonly db: Db;
    readonly automations: readonly WorkflowEventWatchAutomation[];
  },
  signal: AbortSignal,
): Promise<void> {
  const targets = new Map<string, WorkflowEventWatchTarget>();
  for (const automation of args.automations) {
    const target = workflowEventWatchTarget(automation);
    if (target) {
      targets.set(targetKey(target), target);
    }
  }

  for (const target of targets.values()) {
    if (target.provider === "gmail") {
      await reconcileGmailWatchesForUser(
        {
          db: args.db,
          orgId: target.orgId,
          userId: target.userId,
        },
        signal,
      );
      continue;
    }
    if (target.provider === "google_forms") {
      await reconcileGoogleFormsWatchesForUser(
        {
          db: args.db,
          orgId: target.orgId,
          userId: target.userId,
          formId: target.formId,
        },
        signal,
      );
      continue;
    }
    await reconcileGoogleCalendarWatchesForUser(
      {
        db: args.db,
        orgId: target.orgId,
        userId: target.userId,
        calendarId: target.calendarId,
      },
      signal,
    );
  }
}
