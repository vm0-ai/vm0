import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import { zeroJobDetail$ } from "./detail.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  type ScheduleBody,
  type CronTimeOption,
} from "../cron.ts";
import type { ScheduleEntry } from "../../../views/zero-page/zero-schedule-card.tsx";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Agent schedule
// ---------------------------------------------------------------------------

interface ScheduleItem {
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
// Schedule time string conversion
// ---------------------------------------------------------------------------

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

function scheduleToTimeString(s: ScheduleItem): string {
  if (s.triggerType === "loop" && s.intervalSeconds !== null) {
    if (s.intervalSeconds % 60 === 0) {
      return `Every ${s.intervalSeconds / 60} minutes`;
    }
    return `Every ${s.intervalSeconds} seconds`;
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

// ---------------------------------------------------------------------------
// Schedule state
// ---------------------------------------------------------------------------

interface ZeroJobScheduleState {
  schedules: ScheduleItem[];
  error: string | null;
}

const scheduleState$ = state<ZeroJobScheduleState>({
  schedules: [],
  error: null,
});

const scheduleLoaded$ = state(false);

/** Reset schedule state to initial values. */
export const resetScheduleState$ = command(({ set }) => {
  set(scheduleState$, { schedules: [], error: null });
  set(scheduleLoaded$, false);
});

export const zeroJobScheduleEntries$ = computed((get) => {
  const items = get(scheduleState$).schedules;
  return [...items]
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((s): ScheduleEntry => {
      return {
        id: s.id,
        time: scheduleToTimeString(s),
        prompt: s.prompt,
        description: s.description,
        enabled: s.enabled,
        name: s.name,
        timezone: s.timezone,
        intervalSeconds: s.intervalSeconds,
      };
    });
});

export const zeroJobScheduleLoading$ = computed((get) => {
  return !get(scheduleLoaded$);
});

export const zeroJobScheduleError$ = computed((get) => {
  return get(scheduleState$).error;
});

export const fetchZeroJobSchedule$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      return;
    }

    try {
      const client = get(zeroClient$)(zeroSchedulesMainContract);
      const result = await client.list();
      if (result.status !== 200) {
        throw new Error(`Failed to fetch schedules (${result.status})`);
      }

      const agentSchedules = result.body.schedules.filter((s) => {
        return s.agentId === detail.agentId;
      });
      set(scheduleState$, { schedules: agentSchedules, error: null });
      set(scheduleLoaded$, true);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch schedules:", error);
      set(scheduleState$, {
        schedules: [],
        error:
          error instanceof Error ? error.message : "Failed to load schedules",
      });
      set(scheduleLoaded$, true);
    }
  },
);

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

export interface ZeroJobScheduleSaveParams {
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

export const saveZeroJobSchedule$ = command(
  async (
    { get, set },
    params: ZeroJobScheduleSaveParams,
    signal: AbortSignal,
  ) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const scheduleName = params.editName ?? `zero-${Date.now().toString(36)}`;

    const base = {
      agentId: detail.agentId,
      name: scheduleName,
      timezone: params.timezone,
      prompt: params.prompt.trim(),
      ...(params.description && { description: params.description.trim() }),
      enabled: true,
    };

    let body: ScheduleBody;

    if (params.freq === "every_n_minutes") {
      body = { ...base, intervalSeconds: params.intervalSeconds };
    } else if (params.freq === "once") {
      if (
        isAtTimePast(params.date, String(params.hour), String(params.minute))
      ) {
        throw new Error("Scheduled time must be in the future");
      }
      const atTime = buildAtTime(
        params.date,
        String(params.hour),
        String(params.minute),
      );
      body = { ...base, atTime };
    } else if (params.freq === "now") {
      body = { ...base, atTime: new Date().toISOString() };
    } else {
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
        dayOfWeek: params.dayOfWeek,
        dayOfMonth: params.dayOfMonth,
      });
      body = { ...base, cronExpression };
    }

    const client = get(zeroClient$)(zeroSchedulesMainContract);
    const result = await client.deploy({ body });
    signal.throwIfAborted();

    if (result.status !== 200 && result.status !== 201) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : `Save failed (${result.status})`;
      throw new Error(detail);
    }

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchZeroJobSchedule$, signal);
  },
);

export const toggleZeroJobScheduleEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroSchedulesEnableContract);
    const action = params.enabled ? "enable" : "disable";
    const result = await client[action]({
      params: { name: params.name },
      body: { agentId: detail.agentId },
    });
    signal.throwIfAborted();

    if (result.status !== 200) {
      const message = `Failed to ${action} schedule (${result.status})`;
      toast.error(message);
      throw new Error(message);
    }

    // Optimistic update: patch the local schedule state instead of refetching
    const current = get(scheduleState$);
    set(scheduleState$, {
      ...current,
      schedules: current.schedules.map((s) => {
        return s.name === params.name ? { ...s, enabled: params.enabled } : s;
      }),
    });
  },
);

export const deleteZeroJobSchedule$ = command(
  async ({ get, set }, scheduleName: string, signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroSchedulesByNameContract);
    const result = await client.delete({
      params: { name: scheduleName },
      query: { agentId: detail.agentId },
    });
    signal.throwIfAborted();

    if (result.status !== 204) {
      const msg =
        result.status === 401 || result.status === 403 || result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Delete failed: ${msg}`);
    }

    toast.success("Schedule deleted");
    await set(fetchZeroJobSchedule$, signal);
  },
);
