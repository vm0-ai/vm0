import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/core/contracts/zero-schedules";
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

// ---------------------------------------------------------------------------
// Agent schedule — reactive async computed
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

const internalScheduleReload$ = state(0);

const reloadJobSchedule$ = command(({ set }) => {
  set(internalScheduleReload$, (prev) => {
    return prev + 1;
  });
});

const rawSchedules$ = computed(async (get): Promise<ScheduleItem[]> => {
  get(internalScheduleReload$);
  const detail = await get(zeroJobDetail$);
  if (!detail) {
    return [];
  }
  const client = get(zeroClient$)(zeroSchedulesMainContract);
  const result = await accept(client.list(), [200]);
  return result.body.schedules.filter((s) => {
    return s.agentId === detail.agentId;
  });
});

export const zeroJobScheduleEntries$ = computed(
  async (get): Promise<ScheduleEntry[]> => {
    const items = await get(rawSchedules$);
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
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
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
    await accept(client.deploy({ body }), [200, 201]);
    signal.throwIfAborted();

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    set(reloadJobSchedule$);
  },
);

export const toggleZeroJobScheduleEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroSchedulesEnableContract);
    const action = params.enabled ? "enable" : "disable";
    await accept(
      client[action]({
        params: { name: params.name },
        body: { agentId: detail.agentId },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadJobSchedule$);
  },
);

export const deleteZeroJobSchedule$ = command(
  async ({ get, set }, scheduleName: string, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroSchedulesByNameContract);
    await accept(
      client.delete({
        params: { name: scheduleName },
        query: { agentId: detail.agentId },
      }),
      [204],
    );
    signal.throwIfAborted();

    toast.success("Schedule deleted");
    set(reloadJobSchedule$);
  },
);
