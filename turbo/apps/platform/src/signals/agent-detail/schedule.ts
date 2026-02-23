import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$ } from "./agent-detail.ts";
import { buildCronExpression, type ScheduleTimeOption } from "./cron.ts";

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
  cronExpression: string | null;
  atTime: string | null;
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
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent schedule state
// ---------------------------------------------------------------------------

const internalAgentSchedule$ = state<ScheduleResponse | null>(null);
export const agentSchedule$ = computed((get) => get(internalAgentSchedule$));

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
      message?: string;
    } | null;
    throw new Error(
      errorData?.message ?? `Delete failed: ${response.statusText}`,
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
  timeOption: ScheduleTimeOption;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const parts = cron.split(" ");
  const minute = parts[0] ?? "0";
  const hour = parts[1] ?? "9";
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  let timeOption: ScheduleTimeOption = "every-day";

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

const internalDialogTimeOption$ = state<ScheduleTimeOption>("every-day");
export const scheduleDialogTimeOption$ = computed((get) =>
  get(internalDialogTimeOption$),
);

export const setScheduleDialogTimeOption$ = command(
  ({ set }, value: string) => {
    if (isScheduleTimeOption(value)) {
      set(internalDialogTimeOption$, value);
    }
  },
);

function isScheduleTimeOption(v: string): v is ScheduleTimeOption {
  return (
    v === "every-weekday" ||
    v === "every-day" ||
    v === "every-week" ||
    v === "every-month"
  );
}

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
  set(internalDialogSaveError$, null);

  if (schedule.cronExpression) {
    const parsed = parseCronExpression(schedule.cronExpression);
    set(internalDialogTimeOption$, parsed.timeOption);
    set(internalDialogHour$, parsed.hour);
    set(internalDialogMinute$, parsed.minute);
    set(internalDialogDayOfWeek$, parsed.dayOfWeek);
    set(internalDialogDayOfMonth$, parsed.dayOfMonth);
  } else {
    set(internalDialogTimeOption$, "every-day");
    set(internalDialogHour$, "9");
    set(internalDialogMinute$, "0");
    set(internalDialogDayOfWeek$, "1");
    set(internalDialogDayOfMonth$, "1");
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

  if (!detail || !prompt.trim()) {
    return;
  }

  set(internalDialogSaving$, true);
  set(internalDialogSaveError$, null);

  try {
    const fetchFn = get(fetch$);
    const cronExpression = buildCronExpression({
      timeOption,
      hour,
      minute,
      dayOfWeek,
      dayOfMonth,
    });
    const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

    const response = await fetchFn("/api/agent/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        composeId: detail.id,
        name: "default",
        cronExpression,
        timezone,
        prompt: prompt.trim(),
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        errorData?.message ?? `Save failed: ${response.statusText}`,
      );
    }

    // Enable the schedule (backend creates/updates with enabled=false)
    const enableResponse = await fetchFn(
      `/api/agent/schedules/default/enable`,
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
