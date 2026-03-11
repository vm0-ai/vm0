import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  buildCronExpression,
  buildAtTime,
  type ScheduleBody,
  type CronTimeOption,
} from "../agent-detail/cron.ts";

const L = logger("ZeroSchedule");

// ---------------------------------------------------------------------------
// Schedule response type (matches API schema)
// ---------------------------------------------------------------------------

interface ScheduleResponse {
  id: string;
  composeId: string;
  composeName: string;
  scopeSlug: string;
  name: string;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalSchedules$ = state<ScheduleResponse[]>([]);

// ---------------------------------------------------------------------------
// Convert ScheduleResponse to display time string
// ---------------------------------------------------------------------------

function scheduleToTimeString(s: ScheduleResponse): string {
  if (s.triggerType === "loop" && s.intervalSeconds !== null) {
    const minutes = Math.round(s.intervalSeconds / 60);
    return `Every ${minutes} minutes`;
  }

  if (s.triggerType === "once" && s.atTime) {
    const at = new Date(s.atTime);
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    const hour = at.getHours();
    const minute = at.getMinutes();
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `Once on ${date} at ${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
  }

  if (s.cronExpression) {
    return cronToTimeString(s.cronExpression);
  }

  return "Scheduled";
}

function cronToTimeString(cron: string): string {
  const parts = cron.split(" ");
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const timeStr = `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;

  if (dayOfWeek === "1-5") {
    return `Every weekday at ${timeStr}`;
  }
  if (dayOfMonth !== "*") {
    return `Every month at ${timeStr}`;
  }
  if (dayOfWeek !== "*") {
    return `Every week at ${timeStr}`;
  }
  return `Every day at ${timeStr}`;
}

// ---------------------------------------------------------------------------
// Exported schedule entries (display format)
// ---------------------------------------------------------------------------

interface ZeroScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  enabled: boolean;
  /** Original schedule name for API operations */
  name: string;
}

export const zeroScheduleEntries$ = computed((get) => {
  const schedules = get(internalSchedules$);
  return schedules.map(
    (s): ZeroScheduleEntry => ({
      id: s.id,
      time: scheduleToTimeString(s),
      prompt: s.prompt,
      enabled: s.enabled,
      name: s.name,
    }),
  );
});

// ---------------------------------------------------------------------------
// Fetch schedules for the default agent
// ---------------------------------------------------------------------------

export const fetchZeroSchedules$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  const composeId = status.defaultAgentComposeId;
  if (!composeId) {
    set(internalSchedules$, []);
    return;
  }

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/agent/schedules");

    if (!response.ok) {
      set(internalSchedules$, []);
      return;
    }

    const data = (await response.json()) as {
      schedules: ScheduleResponse[];
    };

    // Filter schedules for this agent's composeId
    const agentSchedules = data.schedules.filter(
      (s) => s.composeId === composeId,
    );
    set(internalSchedules$, agentSchedules);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch zero schedules:", error);
    set(internalSchedules$, []);
  }
});

// ---------------------------------------------------------------------------
// Save schedule (create or update)
// ---------------------------------------------------------------------------

export interface ZeroScheduleSaveParams {
  prompt: string;
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
  /** Schedule name when editing an existing schedule */
  editName?: string;
}

export const saveZeroSchedule$ = command(
  async ({ get, set }, params: ZeroScheduleSaveParams) => {
    const status = await get(zeroOnboardingStatus$);
    const composeId = status.defaultAgentComposeId;
    if (!composeId) {
      throw new Error("No default agent configured");
    }

    const fetchFn = get(fetch$);
    const scheduleName = params.editName ?? `zero-${Date.now().toString(36)}`;

    const base = {
      composeId,
      name: scheduleName,
      timezone: params.timezone,
      prompt: params.prompt.trim(),
    };

    let body: ScheduleBody;

    if (params.freq === "every_n_minutes") {
      body = { ...base, intervalSeconds: params.loopMinutes * 60 };
    } else if (params.freq === "once") {
      const atTime = buildAtTime(
        params.date,
        String(params.hour),
        String(params.minute),
      );
      body = { ...base, atTime };
    } else if (params.freq === "now") {
      // "Now" → run once immediately (atTime = now)
      body = { ...base, atTime: new Date().toISOString() };
    } else {
      // Map freq to cron time option
      const freqMap: Record<string, CronTimeOption> = {
        every_weekday: "every-weekday",
        every_day: "every-day",
        every_week: "every-week",
        every_month: "every-month",
      };
      const timeOption = freqMap[params.freq];
      if (!timeOption) {
        throw new Error(`Unknown schedule frequency: ${params.freq}`);
      }
      const cronExpression = buildCronExpression({
        timeOption,
        hour: String(params.hour),
        minute: String(params.minute),
      });
      body = { ...base, cronExpression };
    }

    const response = await fetchFn("/api/agent/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Save failed: ${response.statusText}`,
      );
    }

    // Enable the schedule
    const enableResponse = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(scheduleName)}/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId }),
      },
    );

    if (!enableResponse.ok) {
      throw new Error(
        `Schedule saved but failed to enable: ${enableResponse.statusText}`,
      );
    }

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchZeroSchedules$);
  },
);

// ---------------------------------------------------------------------------
// Delete schedule
// ---------------------------------------------------------------------------

export const deleteZeroSchedule$ = command(
  async ({ get, set }, scheduleName: string) => {
    const status = await get(zeroOnboardingStatus$);
    const composeId = status.defaultAgentComposeId;
    if (!composeId) {
      throw new Error("No default agent configured");
    }

    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(scheduleName)}?composeId=${encodeURIComponent(composeId)}`,
      { method: "DELETE" },
    );

    if (!response.ok && response.status !== 204) {
      const errorData = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Delete failed: ${response.statusText}`,
      );
    }

    toast.success("Schedule deleted");
    await set(fetchZeroSchedules$);
  },
);
