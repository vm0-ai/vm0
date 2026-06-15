import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";

import { now, nowDate } from "../../../lib/time.ts";
import { zeroClient$ } from "../../api-client.ts";
import { agentDetail$ } from "./detail.ts";
import { userPreferences$ } from "../settings/user-preferences.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  cronUtcToLocalTime,
  atTimeInTimezone,
  type AutomationFormBody,
  type CronTimeOption,
} from "../cron.ts";
import {
  listAutomations,
  deployAutomation,
  setAutomationEnabled,
  deleteAutomation,
} from "../automations-api.ts";
import type { AutomationEntry } from "../../../views/zero-page/zero-automation-card.tsx";

// ---------------------------------------------------------------------------
// Agent automation — reactive async computed
// ---------------------------------------------------------------------------

interface AutomationItem {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
  description: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Automation time string conversion
// ---------------------------------------------------------------------------

function cronToTimeString(cron: string, timezone = "UTC"): string {
  const parts = cron.split(" ");
  const rawMinute = Number(parts[0]);
  const rawHour = Number(parts[1]);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  const { hour, minute } = cronUtcToLocalTime(rawHour, rawMinute, timezone);

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
    return cronToTimeString(s.cronExpression, tz);
  }
  return "Upcoming";
}

// ---------------------------------------------------------------------------
// Automation state
// ---------------------------------------------------------------------------

const internalAutomationReload$ = state(0);

const reloadAgentAutomation$ = command(({ set }) => {
  set(internalAutomationReload$, (prev) => {
    return prev + 1;
  });
});

const rawAutomations$ = computed(async (get): Promise<AutomationItem[]> => {
  get(internalAutomationReload$);
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

// ---------------------------------------------------------------------------
// Automation CRUD
// ---------------------------------------------------------------------------

interface AgentAutomationSaveParams {
  prompt: string;
  description?: string;
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  intervalSeconds: number;
  dayOfWeek?: string;
  dayOfMonth?: string;
  editName?: string;
}

export const saveAgentAutomation$ = command(
  async (
    { get, set },
    params: AgentAutomationSaveParams,
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const automationName = params.editName ?? `zero-${now().toString(36)}`;

    const base = {
      agentId: detail.agentId,
      name: automationName,
      timezone: params.timezone,
      prompt: params.prompt.trim(),
      ...(params.description && { description: params.description.trim() }),
      enabled: true,
    };

    let body: AutomationFormBody;

    if (params.freq === "every_n_minutes") {
      body = { ...base, intervalSeconds: params.intervalSeconds };
    } else if (params.freq === "once") {
      if (
        isAtTimePast(params.date, String(params.hour), String(params.minute))
      ) {
        throw new Error("The selected time must be in the future");
      }
      const atTime = buildAtTime(
        params.date,
        String(params.hour),
        String(params.minute),
      );
      body = { ...base, atTime };
    } else if (params.freq === "now") {
      body = { ...base, atTime: nowDate().toISOString() };
    } else {
      const freqMap: Record<string, CronTimeOption> = {
        every_weekday: "every-weekday",
        every_day: "every-day",
        every_week: "every-week",
        every_month: "every-month",
      };
      const timeOption = freqMap[params.freq];
      if (!timeOption) {
        throw new Error(`Unknown automation frequency: ${params.freq}`);
      }
      const cronExpression = buildCronExpression({
        timeOption,
        hour: String(params.hour),
        minute: String(params.minute),
        dayOfWeek: params.dayOfWeek,
        dayOfMonth: params.dayOfMonth,
      });
      body = { ...base, cronExpression };
    }

    await deployAutomation(
      get(zeroClient$),
      body,
      params.editName !== undefined,
    );
    signal.throwIfAborted();

    toast.success(
      params.editName ? "Automation updated" : "Automation created",
    );
    set(reloadAgentAutomation$);
  },
);

export const toggleAgentAutomationEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    await setAutomationEnabled(get(zeroClient$), {
      name: params.name,
      agentId: detail.agentId,
      enabled: params.enabled,
    });
    signal.throwIfAborted();

    set(reloadAgentAutomation$);
  },
);

export const deleteAgentAutomation$ = command(
  async ({ get, set }, automationName: string, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    await deleteAutomation(get(zeroClient$), {
      name: automationName,
      agentId: detail.agentId,
    });
    signal.throwIfAborted();

    toast.success("Automation deleted");
    set(reloadAgentAutomation$);
  },
);
