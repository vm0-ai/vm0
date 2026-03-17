import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  type ScheduleBody,
  type CronTimeOption,
} from "./cron.ts";

const L = logger("ZeroSchedule");

// ---------------------------------------------------------------------------
// Schedule response type (matches API schema)
// ---------------------------------------------------------------------------

interface ScheduleResponse {
  id: string;
  composeId: string;
  composeName: string;
  orgSlug: string;
  name: string;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
  enabled: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
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
    if (s.intervalSeconds % 60 === 0) {
      const minutes = s.intervalSeconds / 60;
      return `Every ${minutes} minutes`;
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
      .map((d) => dayNames[d])
      .filter(Boolean);
    if (days.length > 0) {
      return `Every week on ${days.join(", ")} at ${timeStr}`;
    }
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
  notifyEmail: boolean;
  notifySlack: boolean;
  /** Original schedule name for API operations */
  name: string;
  /** Raw interval in seconds for loop schedules */
  intervalSeconds: number | null;
}

export const zeroScheduleEntries$ = computed((get) => {
  const schedules = get(internalSchedules$);
  return [...schedules]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(
      (s): ZeroScheduleEntry => ({
        id: s.id,
        time: scheduleToTimeString(s),
        prompt: s.prompt,
        enabled: s.enabled,
        notifyEmail: s.notifyEmail,
        notifySlack: s.notifySlack,
        name: s.name,
        intervalSeconds: s.intervalSeconds,
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
  intervalSeconds: number;
  dayOfWeek?: string;
  dayOfMonth?: string;
  /** Schedule name when editing an existing schedule */
  editName?: string;
  notifyEmail?: boolean;
  notifySlack?: boolean;
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
      enabled: true,
      ...(params.notifyEmail !== undefined && {
        notifyEmail: params.notifyEmail,
      }),
      ...(params.notifySlack !== undefined && {
        notifySlack: params.notifySlack,
      }),
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
        dayOfWeek: params.dayOfWeek,
        dayOfMonth: params.dayOfMonth,
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

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchZeroSchedules$);
  },
);

// ---------------------------------------------------------------------------
// Toggle schedule enabled/disabled
// ---------------------------------------------------------------------------

export const toggleZeroScheduleEnabled$ = command(
  async ({ get, set }, params: { name: string; enabled: boolean }) => {
    const status = await get(zeroOnboardingStatus$);
    const composeId = status.defaultAgentComposeId;
    if (!composeId) {
      throw new Error("No default agent configured");
    }

    const fetchFn = get(fetch$);
    const action = params.enabled ? "enable" : "disable";
    const response = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(params.name)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId }),
      },
    );

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message =
        errorData?.error?.message ??
        `Failed to ${action} schedule: ${response.statusText}`;
      toast.error(message);
      throw new Error(message);
    }

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

// ---------------------------------------------------------------------------
// All-org schedule entries (for schedule page — no composeId filter)
// ---------------------------------------------------------------------------

export interface OrgScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  enabled: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
  name: string;
  intervalSeconds: number | null;
  composeId: string;
  composeName: string;
}

const internalAllSchedules$ = state<ScheduleResponse[]>([]);
const internalAllSchedulesLoaded$ = state(false);

/** Whether the org schedules have been loaded at least once. */
export const allOrgSchedulesLoaded$ = computed((get) =>
  get(internalAllSchedulesLoaded$),
);

export const allOrgScheduleEntries$ = computed((get) => {
  const schedules = get(internalAllSchedules$);
  return [...schedules]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(
      (s): OrgScheduleEntry => ({
        id: s.id,
        time: scheduleToTimeString(s),
        prompt: s.prompt,
        enabled: s.enabled,
        notifyEmail: s.notifyEmail,
        notifySlack: s.notifySlack,
        name: s.name,
        intervalSeconds: s.intervalSeconds,
        composeId: s.composeId,
        composeName: s.composeName,
      }),
    );
});

export const fetchAllOrgSchedules$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  try {
    const response = await fetchFn("/api/agent/schedules");
    if (!response.ok) {
      set(internalAllSchedules$, []);
      return;
    }
    const data = (await response.json()) as {
      schedules: ScheduleResponse[];
    };
    set(internalAllSchedules$, data.schedules);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch all org schedules:", error);
    set(internalAllSchedules$, []);
  } finally {
    set(internalAllSchedulesLoaded$, true);
  }
});

export const saveOrgSchedule$ = command(
  async (
    { get, set },
    params: ZeroScheduleSaveParams & { composeId: string },
  ) => {
    const fetchFn = get(fetch$);
    const scheduleName = params.editName ?? `zero-${Date.now().toString(36)}`;

    const base = {
      composeId: params.composeId,
      name: scheduleName,
      timezone: params.timezone,
      prompt: params.prompt.trim(),
      enabled: true,
      ...(params.notifyEmail !== undefined && {
        notifyEmail: params.notifyEmail,
      }),
      ...(params.notifySlack !== undefined && {
        notifySlack: params.notifySlack,
      }),
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

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchAllOrgSchedules$);
  },
);

export const toggleOrgScheduleEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean; composeId: string },
  ) => {
    const fetchFn = get(fetch$);
    const action = params.enabled ? "enable" : "disable";
    const response = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(params.name)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: params.composeId }),
      },
    );

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message =
        errorData?.error?.message ??
        `Failed to ${action} schedule: ${response.statusText}`;
      toast.error(message);
      throw new Error(message);
    }

    await set(fetchAllOrgSchedules$);
  },
);

export const deleteOrgSchedule$ = command(
  async ({ get, set }, params: { name: string; composeId: string }) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(params.name)}?composeId=${encodeURIComponent(params.composeId)}`,
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
    await set(fetchAllOrgSchedules$);
  },
);
