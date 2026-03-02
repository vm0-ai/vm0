import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$ } from "./agent-detail.ts";
import {
  startInlineRun$,
  prepareNewRun$,
  cancelPendingRun$,
} from "./inline-run.ts";
import { fetchAgentSchedule$ } from "./schedule.ts";
import { type ScheduleTimeOption, buildCronExpression } from "./cron.ts";
import { closeChatPanel$ } from "./chat.ts";

const L = logger("RunDialog");

// ---------------------------------------------------------------------------
// Dialog open/close state
// ---------------------------------------------------------------------------

const internalOpen$ = state(false);
export const runDialogOpen$ = computed((get) => get(internalOpen$));

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const internalPrompt$ = state("");
export const runDialogPrompt$ = computed((get) => get(internalPrompt$));

export const setRunDialogPrompt$ = command(({ set }, value: string) => {
  set(internalPrompt$, value);
});

type TimeOption = "now" | ScheduleTimeOption;

const internalTimeOption$ = state<TimeOption>("now");
export const runDialogTimeOption$ = computed((get) => get(internalTimeOption$));

function isTimeOption(v: string): v is TimeOption {
  return (
    v === "now" ||
    v === "every-weekday" ||
    v === "every-day" ||
    v === "every-week" ||
    v === "every-month"
  );
}

export const setRunDialogTimeOption$ = command(({ set }, value: string) => {
  if (isTimeOption(value)) {
    set(internalTimeOption$, value);
  }
});

// Frequency (hour of day for schedule options)
const internalFrequency$ = state("9");
export const runDialogFrequency$ = computed((get) => get(internalFrequency$));

export const setRunDialogFrequency$ = command(({ set }, value: string) => {
  set(internalFrequency$, value);
});

// Minute of hour for schedule options
const internalMinute$ = state("0");
export const runDialogMinute$ = computed((get) => get(internalMinute$));

export const setRunDialogMinute$ = command(({ set }, value: string) => {
  set(internalMinute$, value);
});

// Day of week for "every-week" (cron: 0=Sun, 1=Mon, ..., 6=Sat)
const internalDayOfWeek$ = state("1");
export const runDialogDayOfWeek$ = computed((get) => get(internalDayOfWeek$));

export const setRunDialogDayOfWeek$ = command(({ set }, value: string) => {
  set(internalDayOfWeek$, value);
});

// Day of month for "every-month" (1-31)
const internalDayOfMonth$ = state("1");
export const runDialogDayOfMonth$ = computed((get) => get(internalDayOfMonth$));

export const setRunDialogDayOfMonth$ = command(({ set }, value: string) => {
  set(internalDayOfMonth$, value);
});

// ---------------------------------------------------------------------------
// Saving state
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const runDialogSaving$ = computed((get) => get(internalSaving$));

// ---------------------------------------------------------------------------
// Save error
// ---------------------------------------------------------------------------

const internalSaveError$ = state<string | null>(null);
export const runDialogSaveError$ = computed((get) => get(internalSaveError$));

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export const openRunDialog$ = command(({ set }) => {
  set(internalPrompt$, "");
  set(internalTimeOption$, "now");
  set(internalFrequency$, "9");
  set(internalMinute$, "0");
  set(internalDayOfWeek$, "1");
  set(internalDayOfMonth$, "1");
  set(internalSaveError$, null);
  set(internalOpen$, true);
});

export const closeRunDialog$ = command(({ set }) => {
  set(internalOpen$, false);
});

// ---------------------------------------------------------------------------
// Submit — immediate run or schedule creation
// ---------------------------------------------------------------------------

export const submitRunDialog$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  const prompt = get(internalPrompt$);
  const timeOption = get(internalTimeOption$);
  const frequency = get(internalFrequency$);
  const minute = get(internalMinute$);
  const dayOfWeek = get(internalDayOfWeek$);
  const dayOfMonth = get(internalDayOfMonth$);

  if (!detail || !prompt.trim()) {
    return;
  }

  set(internalSaving$, true);
  set(internalSaveError$, null);

  try {
    const fetchFn = get(fetch$);

    if (timeOption === "now") {
      // Close dialog immediately — API continues in background
      set(internalOpen$, false);
      set(internalSaving$, false);
      set(closeChatPanel$);
      set(prepareNewRun$);
      toast.success("Starting agent run...");

      try {
        const response = await fetchFn("/api/agent/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: detail.id,
            prompt: prompt.trim(),
          }),
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          set(cancelPendingRun$);
          toast.error(
            errorData?.message ?? `Run failed: ${response.statusText}`,
          );
          return;
        }

        const data = (await response.json()) as { runId: string };
        set(startInlineRun$, data.runId);
      } catch (error) {
        throwIfAbort(error);
        set(cancelPendingRun$);
        toast.error(
          error instanceof Error ? error.message : "Failed to start run",
        );
      }
      return;
    }

    // Schedule creation
    const cronExpression = buildCronExpression({
      timeOption,
      hour: frequency,
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
        errorData?.message ?? `Schedule failed: ${response.statusText}`,
      );
    }

    // Enable the schedule (backend creates with enabled=false)
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

    set(internalOpen$, false);
    toast.success("Schedule created");

    // Refresh the schedule badge in the header
    await set(fetchAgentSchedule$);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to submit run dialog:", error);
    set(
      internalSaveError$,
      error instanceof Error ? error.message : "Failed to submit",
    );
  } finally {
    set(internalSaving$, false);
  }
});
