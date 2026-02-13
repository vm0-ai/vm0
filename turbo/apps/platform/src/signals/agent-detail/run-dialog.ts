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

// Time option: "now" or a schedule preset
type TimeOption =
  | "now"
  | "every-weekday"
  | "every-day"
  | "every-week"
  | "every-month";

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
  set(internalSaveError$, null);
  set(internalOpen$, true);
});

export const closeRunDialog$ = command(({ set }) => {
  set(internalOpen$, false);
});

// ---------------------------------------------------------------------------
// Cron expression mapping
// ---------------------------------------------------------------------------

function buildCronExpression(timeOption: TimeOption, hour: string): string {
  const h = Number.parseInt(hour, 10);
  switch (timeOption) {
    case "every-weekday": {
      return `0 ${String(h)} * * 1-5`;
    }
    case "every-day": {
      return `0 ${String(h)} * * *`;
    }
    case "every-week": {
      return `0 ${String(h)} * * 1`;
    }
    case "every-month": {
      return `0 ${String(h)} 1 * *`;
    }
    default: {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Submit — immediate run or schedule creation
// ---------------------------------------------------------------------------

export const submitRunDialog$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  const prompt = get(internalPrompt$);
  const timeOption = get(internalTimeOption$);
  const frequency = get(internalFrequency$);

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
    const cronExpression = buildCronExpression(timeOption, frequency);
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

    set(internalOpen$, false);
    toast.success("Schedule created");
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
