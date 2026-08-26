import {
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";

import type { Db } from "../external/db";
import {
  ensureGmailWatchForUser,
  reconcileGmailWatchesForUser,
} from "./gmail-automation-event.service";
import {
  ensureGoogleCalendarWatchForUser,
  reconcileGoogleCalendarWatchesForUser,
} from "./google-calendar-automation-event.service";
import {
  ensureGoogleFormsWatchForUser,
  reconcileGoogleFormsWatchesForUser,
} from "./google-forms-automation-event.service";

interface AutomationEventWatchAutomation {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
}

type AutomationEventWatchTarget =
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
      readonly connectorId: string;
    };

function googleCalendarId(
  automation: AutomationEventWatchAutomation,
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

function automationEventWatchTarget(
  automation: AutomationEventWatchAutomation,
): AutomationEventWatchTarget | null {
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
      connectorId: config.data.connectorId,
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

function targetKey(target: AutomationEventWatchTarget): string {
  if (target.provider === "gmail") {
    return `gmail:${target.orgId}:${target.userId}`;
  }
  if (target.provider === "google_forms") {
    return `google_forms:${target.userId}:${target.formId}`;
  }
  return `google_calendar:${target.orgId}:${target.userId}:${target.calendarId}`;
}

export async function reconcileAutomationEventWatches(
  args: {
    readonly db: Db;
    readonly automations: readonly AutomationEventWatchAutomation[];
  },
  signal: AbortSignal,
): Promise<void> {
  const targets = new Map<string, AutomationEventWatchTarget>();
  for (const automation of args.automations) {
    const target = automationEventWatchTarget(automation);
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

interface CurrentAutomationEventWatchAutomation extends AutomationEventWatchAutomation {
  readonly id: string;
  readonly enabled: boolean;
}

export interface GoogleFormsEventWatchPreparation {
  readonly automationId: string;
  readonly seedCursor: string;
}

export type AutomationEventWatchReconfigurationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad-request"; readonly message: string };

async function ensureNonFormsTarget(
  db: Db,
  target: Exclude<AutomationEventWatchTarget, { provider: "google_forms" }>,
  signal: AbortSignal,
): Promise<AutomationEventWatchReconfigurationResult> {
  const result =
    target.provider === "gmail"
      ? await ensureGmailWatchForUser(
          {
            db,
            orgId: target.orgId,
            userId: target.userId,
            forceRefresh: false,
          },
          signal,
        )
      : await ensureGoogleCalendarWatchForUser(
          {
            db,
            orgId: target.orgId,
            userId: target.userId,
            calendarId: target.calendarId,
            forceRefresh: false,
          },
          signal,
        );
  signal.throwIfAborted();
  return result.kind === "ok"
    ? result
    : { kind: "bad-request", message: result.message };
}

async function ensureGoogleFormsTarget(
  db: Db,
  automation: CurrentAutomationEventWatchAutomation,
  target: Extract<AutomationEventWatchTarget, { provider: "google_forms" }>,
  seedCursor: string | undefined,
  signal: AbortSignal,
): Promise<AutomationEventWatchReconfigurationResult> {
  const result = await ensureGoogleFormsWatchForUser(
    {
      db,
      orgId: target.orgId,
      userId: target.userId,
      formId: target.formId,
      connectorId: target.connectorId,
      ...(seedCursor === undefined
        ? {}
        : {
            resetAutomationId: automation.id,
            seedCursor,
          }),
    },
    signal,
  );
  signal.throwIfAborted();
  return result.kind === "ok"
    ? { kind: "ok" }
    : { kind: "bad-request", message: result.message };
}

export async function reconcileAutomationEventWatchReconfiguration(
  db: Db,
  args: {
    readonly previous: readonly AutomationEventWatchAutomation[];
    readonly current: readonly CurrentAutomationEventWatchAutomation[];
    readonly googleForms: readonly GoogleFormsEventWatchPreparation[];
  },
  signal: AbortSignal,
): Promise<AutomationEventWatchReconfigurationResult> {
  const seedByAutomationId = new Map(
    args.googleForms.map((entry) => {
      return [entry.automationId, entry.seedCursor] as const;
    }),
  );
  const nonFormsTargets = new Map<
    string,
    Exclude<AutomationEventWatchTarget, { provider: "google_forms" }>
  >();
  for (const automation of args.current) {
    if (!automation.enabled) {
      continue;
    }
    const target = automationEventWatchTarget(automation);
    if (!target) {
      continue;
    }
    if (target.provider === "google_forms") {
      const ensured = await ensureGoogleFormsTarget(
        db,
        automation,
        target,
        seedByAutomationId.get(automation.id),
        signal,
      );
      if (ensured.kind !== "ok") {
        return ensured;
      }
      continue;
    }
    nonFormsTargets.set(targetKey(target), target);
  }
  for (const target of nonFormsTargets.values()) {
    const ensured = await ensureNonFormsTarget(db, target, signal);
    if (ensured.kind !== "ok") {
      return ensured;
    }
  }
  await reconcileAutomationEventWatches(
    { db, automations: [...args.previous, ...args.current] },
    signal,
  );
  return { kind: "ok" };
}
