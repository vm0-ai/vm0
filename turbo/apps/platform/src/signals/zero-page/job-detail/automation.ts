import { computed } from "ccstate";

import { zeroClient$ } from "../../api-client.ts";
import { agentDetail$ } from "./detail.ts";
import { userPreferences$ } from "../settings/user-preferences.ts";
import { cronTimeInTimezone, atTimeInTimezone } from "../cron.ts";
import { listAutomations } from "../automations-api.ts";
import type { AutomationEntry } from "../../../views/zero-page/automation-utils.ts";

// ---------------------------------------------------------------------------
// Agent automation — reactive async computed
// ---------------------------------------------------------------------------

interface AutomationItem {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  triggerType: "cron" | "once" | "loop" | null;
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string | null;
  prompt: string;
  description: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Automation time string conversion
// ---------------------------------------------------------------------------

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

function automationToTimeString(
  s: AutomationItem,
  displayTimezone?: string,
): string {
  const tz = displayTimezone ?? s.timezone ?? "UTC";
  if (s.triggerType === "loop" && s.intervalSeconds !== null) {
    if (s.intervalSeconds % 60 === 0) {
      return `Every ${s.intervalSeconds / 60} minutes`;
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

// ---------------------------------------------------------------------------
// Automation state
// ---------------------------------------------------------------------------

const rawAutomations$ = computed(async (get): Promise<AutomationItem[]> => {
  const detail = await get(agentDetail$);
  if (!detail) {
    return [];
  }
  const automations = await listAutomations(get(zeroClient$));
  return automations.filter((s) => {
    return s.agentId === detail.agentId;
  });
});

export const agentAutomationEntries$ = computed(
  async (get): Promise<AutomationEntry[]> => {
    const items = await get(rawAutomations$);
    const prefs = await get(userPreferences$);
    const displayTz =
      prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return [...items]
      .sort((a, b) => {
        return b.createdAt.localeCompare(a.createdAt);
      })
      .map((s): AutomationEntry => {
        return {
          id: s.id,
          time: automationToTimeString(s, displayTz),
          prompt: s.prompt,
          description: s.description,
          enabled: s.enabled,
          name: s.name,
          timezone: displayTz,
          intervalSeconds: s.intervalSeconds,
        };
      });
  },
);
