/* eslint-disable no-restricted-syntax */
// This file contains a large amount of TRACE_CACHE that needs to be cleaned up in subsequent modifications.
// Additionally, other files must not reference this file to implement file-level no-restricted-syntax operations.

import { command, computed, state } from "ccstate";
import { zeroClient$ } from "../api-client.ts";
import { cronTimeInTimezone, atTimeInTimezone } from "./cron.ts";
import {
  listAutomations,
  type PlatformAutomationView,
} from "./automations-api.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";

// ---------------------------------------------------------------------------
// Convert the platform automation projection to a display trigger string
// ---------------------------------------------------------------------------

export function automationToTimeString(
  s: PlatformAutomationView,
  displayTimezone?: string,
): string {
  const tz = displayTimezone ?? s.timezone ?? "UTC";

  if (s.triggerType === "loop" && s.intervalSeconds !== null) {
    if (s.intervalSeconds % 60 === 0) {
      const minutes = s.intervalSeconds / 60;
      return `Every ${minutes} minutes`;
    }
    return `Every ${s.intervalSeconds} seconds`;
  }

  if (s.triggerType === "once" && s.atTime) {
    const { date, hour, minute } = atTimeInTimezone(s.atTime, tz);
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `Once on ${date} at ${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
  }

  if (s.cronExpression) {
    return cronToTimeString(s.cronExpression, s.timezone ?? "UTC", tz);
  }

  return "Upcoming";
}

function cronToTimeString(
  cron: string,
  sourceTimezone = "UTC",
  displayTimezone = sourceTimezone,
): string {
  const parts = cron.split(" ");
  const rawMinute = Number(parts[0]);
  const rawHour = Number(parts[1]);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  const { hour, minute } = cronTimeInTimezone(
    rawHour,
    rawMinute,
    sourceTimezone,
    displayTimezone,
  );

  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const timeStr = `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;

  if (dayOfWeek === "1-5") {
    return `Every weekday at ${timeStr}`;
  }
  if (dayOfMonth !== "*") {
    return `Every month on day ${dayOfMonth} at ${timeStr}`;
  }
  if (dayOfWeek !== "*") {
    const dayNames: Record<string, string> = {
      "0": "Sunday",
      "1": "Monday",
      "2": "Tuesday",
      "3": "Wednesday",
      "4": "Thursday",
      "5": "Friday",
      "6": "Saturday",
    };
    const days = dayOfWeek
      .split(",")
      .map((d) => {
        return dayNames[d];
      })
      .filter(Boolean);
    if (days.length > 0) {
      return `Every week on ${days.join(", ")} at ${timeStr}`;
    }
    return `Every week at ${timeStr}`;
  }
  return `Every day at ${timeStr}`;
}

// ---------------------------------------------------------------------------
// All-org automation entries (for automations page — no agent filter)
// ---------------------------------------------------------------------------

export interface OrgAutomationEntry {
  id: string;
  time: string;
  prompt: string;
  description: string | null;
  enabled: boolean;
  name: string;
  /** IANA timezone used for display (user's preferred timezone) */
  timezone: string;
  intervalSeconds: number | null;
  agentId: string;
  displayName: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  chatThreadId: string;
  triggerSummary: string;
}

const internalAllAutomations$ = state<PlatformAutomationView[]>([]);
const internalAllAutomationsLoaded$ = state(false);

/** True after the first successful org automation fetch has completed. */
export const allOrgAutomationsLoaded$ = computed((get) => {
  return get(internalAllAutomationsLoaded$);
});

export const allOrgAutomationEntries$ = computed(async (get) => {
  const automations = get(internalAllAutomations$);
  const prefs = await get(userPreferences$);
  const displayTz =
    prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...automations]
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((s): OrgAutomationEntry => {
      const triggerSummary = automationToTimeString(s, displayTz);
      return {
        id: s.id,
        time: triggerSummary,
        prompt: s.prompt,
        description: s.description,
        enabled: s.enabled,
        name: s.name,
        timezone: displayTz,
        intervalSeconds: s.intervalSeconds,
        agentId: s.agentId,
        displayName: s.displayName,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        chatThreadId: s.chatThreadId,
        triggerSummary,
      };
    });
});

export const fetchAllOrgAutomations$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const automations = await listAutomations(get(zeroClient$), {
      signal,
    }).finally(() => {
      set(internalAllAutomationsLoaded$, true);
    });
    signal.throwIfAborted();
    set(internalAllAutomations$, automations);
  },
);
