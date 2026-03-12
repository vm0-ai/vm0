import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$ } from "./agent-detail.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  getTomorrowDateLocal,
  getBrowserTimezone,
  type CronTimeOption,
  type ScheduleTimeOption,
  type ScheduleBody,
} from "./cron.ts";

const L = logger("Schedule");

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
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  artifactName: string | null;
  artifactVersion: string | null;
  volumeVersions: Record<string, string> | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  retryStartedAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent schedule state
// ---------------------------------------------------------------------------

const internalAgentSchedule$ = state<ScheduleResponse | null>(null);
export const agentSchedule$ = computed((get) => get(internalAgentSchedule$));

/** Human-readable summary of the current schedule for tooltip display. */
export const agentScheduleSummary$ = computed((get) => {
  const schedule = get(internalAgentSchedule$);
  if (!schedule) {
    return null;
  }

  const parts: string[] = [];

  if (schedule.triggerType === "loop" && schedule.intervalSeconds !== null) {
    parts.push(describeLoop(schedule.intervalSeconds));
  } else if (schedule.cronExpression) {
    parts.push(describeCron(schedule.cronExpression));
  } else if (schedule.atTime) {
    const at = new Date(schedule.atTime);
    parts.push(
      `Once at ${at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    );
  }

  if (schedule.timezone) {
    parts.push(schedule.timezone);
  }

  if (schedule.nextRunAt) {
    const next = new Date(schedule.nextRunAt);
    parts.push(
      `Next: ${next.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    );
  }

  return parts.join("\n");
});

function describeLoop(intervalSeconds: number): string {
  if (intervalSeconds === 0) {
    return "Loop (immediate)";
  }
  if (intervalSeconds < 60) {
    return `Loop interval ${intervalSeconds}s`;
  }
  if (intervalSeconds < 3600) {
    const m = Math.floor(intervalSeconds / 60);
    return `Loop interval ${m}m`;
  }
  const h = Math.floor(intervalSeconds / 3600);
  const remainMin = Math.floor((intervalSeconds % 3600) / 60);
  if (remainMin === 0) {
    return `Loop interval ${h}h`;
  }
  return `Loop interval ${h}h ${remainMin}m`;
}

function describeCron(cron: string): string {
  const dayNames: Record<string, string> = {
    "0": "Sunday",
    "1": "Monday",
    "2": "Tuesday",
    "3": "Wednesday",
    "4": "Thursday",
    "5": "Friday",
    "6": "Saturday",
    "7": "Sunday",
  };
  const parsed = parseCronExpression(cron);
  const hh = parsed.hour.padStart(2, "0");
  const mm = parsed.minute.padStart(2, "0");
  const time = `${hh}:${mm}`;

  switch (parsed.timeOption) {
    case "every-weekday": {
      return `Weekdays at ${time}`;
    }
    case "every-day": {
      return `Daily at ${time}`;
    }
    case "every-week": {
      return `${dayNames[parsed.dayOfWeek] ?? `Day ${parsed.dayOfWeek}`}s at ${time}`;
    }
    case "every-month": {
      return `Monthly on day ${parsed.dayOfMonth} at ${time}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch agent schedule
// ---------------------------------------------------------------------------

export const fetchAgentSchedule$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/agent/schedules");

    if (!response.ok) {
      set(internalAgentSchedule$, null);
      return;
    }

    const data = (await response.json()) as {
      schedules: ScheduleResponse[];
    };

    // Find the first enabled schedule for this agent (match by composeId for reliability)
    const match = data.schedules.find(
      (s) => s.composeId === detail.id && s.enabled,
    );

    set(internalAgentSchedule$, match ?? null);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch agent schedule:", error);
    set(internalAgentSchedule$, null);
  }
});

// ---------------------------------------------------------------------------
// Delete agent schedule
// ---------------------------------------------------------------------------

const deleteAgentSchedule$ = command(async ({ get, set }) => {
  const schedule = get(internalAgentSchedule$);
  const detail = get(agentDetail$);
  if (!schedule || !detail) {
    return;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn(
    `/api/agent/schedules/${encodeURIComponent(schedule.name)}?composeId=${encodeURIComponent(detail.id)}`,
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

  set(internalAgentSchedule$, null);
});

// ---------------------------------------------------------------------------
// Cron parsing helper
// ---------------------------------------------------------------------------

function parseCronExpression(cron: string): {
  minute: string;
  hour: string;
  timeOption: CronTimeOption;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const parts = cron.split(" ");
  const minute = parts[0] ?? "0";
  const hour = parts[1] ?? "9";
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  let timeOption: CronTimeOption;

  if (dayOfMonth !== "*") {
    timeOption = "every-month";
  } else if (dayOfWeek === "1-5") {
    timeOption = "every-weekday";
  } else if (dayOfWeek !== "*") {
    timeOption = "every-week";
  } else {
    timeOption = "every-day";
  }

  return {
    minute,
    hour,
    timeOption,
    dayOfWeek: dayOfWeek === "*" || dayOfWeek === "1-5" ? "1" : dayOfWeek,
    dayOfMonth: dayOfMonth === "*" ? "1" : dayOfMonth,
  };
}

// ---------------------------------------------------------------------------
// Schedule edit dialog state
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
export const scheduleDialogOpen$ = computed((get) => get(internalDialogOpen$));

const internalDialogPrompt$ = state("");
export const scheduleDialogPrompt$ = computed((get) =>
  get(internalDialogPrompt$),
);

export const setScheduleDialogPrompt$ = command(({ set }, value: string) => {
  set(internalDialogPrompt$, value);
});

type ScheduleDialogTimeOption = ScheduleTimeOption | "once";

const internalDialogTimeOption$ = state<ScheduleDialogTimeOption>("every-day");
export const scheduleDialogTimeOption$ = computed((get) =>
  get(internalDialogTimeOption$),
);

export const setScheduleDialogTimeOption$ = command(
  ({ set }, value: string) => {
    if (isScheduleDialogTimeOption(value)) {
      set(internalDialogTimeOption$, value);
    }
  },
);

function isScheduleDialogTimeOption(v: string): v is ScheduleDialogTimeOption {
  return (
    v === "once" ||
    v === "every-weekday" ||
    v === "every-day" ||
    v === "every-week" ||
    v === "every-month" ||
    v === "loop"
  );
}

const internalDialogIntervalSeconds$ = state("300");
export const scheduleDialogIntervalSeconds$ = computed((get) =>
  get(internalDialogIntervalSeconds$),
);

export const setScheduleDialogIntervalSeconds$ = command(
  ({ set }, value: string) => {
    set(internalDialogIntervalSeconds$, value);
  },
);

const internalDialogDate$ = state(getTomorrowDateLocal());
export const scheduleDialogDate$ = computed((get) => get(internalDialogDate$));

export const setScheduleDialogDate$ = command(({ set }, value: string) => {
  set(internalDialogDate$, value);
});

const internalDialogHour$ = state("9");
export const scheduleDialogHour$ = computed((get) => get(internalDialogHour$));

export const setScheduleDialogHour$ = command(({ set }, value: string) => {
  set(internalDialogHour$, value);
});

const internalDialogMinute$ = state("0");
export const scheduleDialogMinute$ = computed((get) =>
  get(internalDialogMinute$),
);

export const setScheduleDialogMinute$ = command(({ set }, value: string) => {
  set(internalDialogMinute$, value);
});

const internalDialogDayOfWeek$ = state("1");
export const scheduleDialogDayOfWeek$ = computed((get) =>
  get(internalDialogDayOfWeek$),
);

export const setScheduleDialogDayOfWeek$ = command(({ set }, value: string) => {
  set(internalDialogDayOfWeek$, value);
});

const internalDialogDayOfMonth$ = state("1");
export const scheduleDialogDayOfMonth$ = computed((get) =>
  get(internalDialogDayOfMonth$),
);

export const setScheduleDialogDayOfMonth$ = command(
  ({ set }, value: string) => {
    set(internalDialogDayOfMonth$, value);
  },
);

const internalDialogTimezone$ = state(getBrowserTimezone());
export const scheduleDialogTimezone$ = computed((get) =>
  get(internalDialogTimezone$),
);

export const setScheduleDialogTimezone$ = command(({ set }, value: string) => {
  set(internalDialogTimezone$, value);
});

const internalDialogSaving$ = state(false);
export const scheduleDialogSaving$ = computed((get) =>
  get(internalDialogSaving$),
);

const internalDialogSaveError$ = state<string | null>(null);
export const scheduleDialogSaveError$ = computed((get) =>
  get(internalDialogSaveError$),
);

// ---------------------------------------------------------------------------
// Open / close schedule dialog
// ---------------------------------------------------------------------------

export const openScheduleDialog$ = command(({ get, set }) => {
  const schedule = get(internalAgentSchedule$);
  if (!schedule) {
    return;
  }

  set(internalDialogPrompt$, schedule.prompt);
  set(internalDialogTimezone$, schedule.timezone || getBrowserTimezone());
  set(internalDialogSaveError$, null);

  if (schedule.triggerType === "loop" && schedule.intervalSeconds !== null) {
    set(internalDialogTimeOption$, "loop");
    set(internalDialogIntervalSeconds$, String(schedule.intervalSeconds));
  } else if (schedule.cronExpression) {
    const parsed = parseCronExpression(schedule.cronExpression);
    set(internalDialogTimeOption$, parsed.timeOption);
    set(internalDialogHour$, parsed.hour);
    set(internalDialogMinute$, parsed.minute);
    set(internalDialogDayOfWeek$, parsed.dayOfWeek);
    set(internalDialogDayOfMonth$, parsed.dayOfMonth);
    set(internalDialogDate$, getTomorrowDateLocal());
  } else if (schedule.atTime) {
    const at = new Date(schedule.atTime);
    const y = at.getFullYear();
    const mo = String(at.getMonth() + 1).padStart(2, "0");
    const d = String(at.getDate()).padStart(2, "0");
    set(internalDialogTimeOption$, "once");
    set(internalDialogDate$, `${y}-${mo}-${d}`);
    set(internalDialogHour$, String(at.getHours()));
    set(internalDialogMinute$, String(at.getMinutes()));
    set(internalDialogDayOfWeek$, "1");
    set(internalDialogDayOfMonth$, "1");
  } else {
    set(internalDialogTimeOption$, "every-day");
    set(internalDialogHour$, "9");
    set(internalDialogMinute$, "0");
    set(internalDialogDayOfWeek$, "1");
    set(internalDialogDayOfMonth$, "1");
    set(internalDialogDate$, getTomorrowDateLocal());
  }

  set(internalDialogOpen$, true);
});

export const closeScheduleDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

// ---------------------------------------------------------------------------
// Submit schedule edit
// ---------------------------------------------------------------------------

export const submitScheduleDialog$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  const prompt = get(internalDialogPrompt$);
  const timeOption = get(internalDialogTimeOption$);
  const hour = get(internalDialogHour$);
  const minute = get(internalDialogMinute$);
  const dayOfWeek = get(internalDialogDayOfWeek$);
  const dayOfMonth = get(internalDialogDayOfMonth$);
  const intervalSecondsStr = get(internalDialogIntervalSeconds$);

  if (!detail || !prompt.trim()) {
    return;
  }

  set(internalDialogSaving$, true);
  set(internalDialogSaveError$, null);

  try {
    const fetchFn = get(fetch$);
    const date = get(internalDialogDate$);
    const timezone = get(internalDialogTimezone$);

    // Use existing schedule name if editing, otherwise default to "default"
    const existingSchedule = get(internalAgentSchedule$);
    const scheduleName = existingSchedule?.name ?? "default";

    // Build request body based on trigger type
    const base = {
      composeId: detail.id,
      name: scheduleName,
      timezone,
      prompt: prompt.trim(),
    };

    let body: ScheduleBody;

    if (timeOption === "loop") {
      body = {
        ...base,
        intervalSeconds: Number.parseInt(intervalSecondsStr, 10) || 0,
      };
    } else if (timeOption === "once") {
      if (isAtTimePast(date, hour, minute)) {
        set(internalDialogSaveError$, "Scheduled time must be in the future");
        set(internalDialogSaving$, false);
        return;
      }
      const atTime = buildAtTime(date, hour, minute);
      body = {
        ...base,
        atTime,
      };
    } else {
      const cronExpression = buildCronExpression({
        timeOption,
        hour,
        minute,
        dayOfWeek,
        dayOfMonth,
      });
      body = {
        ...base,
        cronExpression,
      };
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

    // Enable the schedule (backend creates/updates with enabled=false)
    const enableResponse = await fetchFn(
      `/api/agent/schedules/${encodeURIComponent(scheduleName)}/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: detail.id }),
      },
    );

    if (!enableResponse.ok) {
      L.warn("Failed to enable schedule:", enableResponse.statusText);
    }

    set(internalDialogOpen$, false);
    toast.success("Schedule updated");
    await set(fetchAgentSchedule$);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to update schedule:", error);
    set(
      internalDialogSaveError$,
      error instanceof Error ? error.message : "Failed to save",
    );
  } finally {
    set(internalDialogSaving$, false);
  }
});

// ---------------------------------------------------------------------------
// Delete schedule from dialog
// ---------------------------------------------------------------------------

export const deleteScheduleFromDialog$ = command(async ({ set }) => {
  set(internalDialogSaving$, true);
  set(internalDialogSaveError$, null);

  try {
    await set(deleteAgentSchedule$);
    set(internalDialogOpen$, false);
    toast.success("Schedule deleted");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to delete schedule:", error);
    set(
      internalDialogSaveError$,
      error instanceof Error ? error.message : "Failed to delete",
    );
  } finally {
    set(internalDialogSaving$, false);
  }
});
