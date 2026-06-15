/* eslint-disable no-restricted-syntax */
// This file contains a large amount of TRACE_CACHE that needs to be cleaned up in subsequent modifications.
// Additionally, other files must not reference this file to implement file-level no-restricted-syntax operations.

import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { createElement } from "react";
import { Link } from "../../views/router/link.tsx";
import { zeroClient$ } from "../api-client.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  cronUtcToLocalTime,
  atTimeInTimezone,
  type AutomationFormBody,
  type CronTimeOption,
} from "./cron.ts";
import {
  listAutomations,
  deployAutomation,
  updateAutomationIntent,
  setAutomationEnabled,
  deleteAutomation,
  runAutomationNow as runAutomationNowApi,
  type PlatformAutomationView,
} from "./automations-api.ts";
import { ApiError } from "../../lib/accept.ts";
import { now, nowDate } from "../../lib/time.ts";
import { markDetachedErrorHandled, throwIfAbort } from "../utils.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const AUTOMATION_TIME_PAST_MESSAGE = "The selected time must be in the future";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Automation tab saving state (used by ZeroAutomationTab to show loading during save)
const internalAutomationTabSaving$ = state(false);

export const automationTabSaving$ = computed((get) => {
  return get(internalAutomationTabSaving$);
});

export const setAutomationTabSaving$ = command(({ set }, value: boolean) => {
  set(internalAutomationTabSaving$, value);
});

// ---------------------------------------------------------------------------
// Convert the platform automation projection to a display trigger string
// ---------------------------------------------------------------------------

function automationToTimeString(
  s: PlatformAutomationView,
  displayTimezone?: string,
): string {
  const tz = displayTimezone ?? s.timezone ?? "UTC";

  if (s.triggerReadOnlyReason === "multiple_triggers") {
    return `${s.triggerCount} triggers`;
  }
  if (s.triggerReadOnlyReason === "unsupported_trigger") {
    const [kind] = s.triggerKinds;
    return triggerKindLabel(kind);
  }
  if (s.triggerReadOnlyReason === "no_trigger") {
    return "No trigger";
  }

  if (s.triggerType === "loop" && s.intervalSeconds !== null) {
    if (s.intervalSeconds % 60 === 0) {
      const minutes = s.intervalSeconds / 60;
      return `Every ${minutes} minutes`;
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

function triggerKindLabel(
  kind: PlatformAutomationView["triggerKinds"][number] | undefined,
): string {
  if (kind === "cron") {
    return "Schedule";
  }
  if (kind === "once") {
    return "Once";
  }
  if (kind === "loop") {
    return "Loop";
  }
  if (kind === "webhook") {
    return "Webhook";
  }
  return "No trigger";
}

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

function buildAutomationFormBody(
  agentId: string,
  params: ZeroAutomationSaveParams,
): AutomationFormBody {
  const automationName = params.editName ?? `zero-${now().toString(36)}`;

  const base = {
    agentId,
    name: automationName,
    timezone: params.timezone,
    prompt: params.prompt.trim(),
    ...(params.description && { description: params.description.trim() }),
    enabled: true,
  };

  if (params.freq === "every_n_minutes") {
    return { ...base, intervalSeconds: params.intervalSeconds };
  }

  if (params.freq === "once") {
    if (isAtTimePast(params.date, String(params.hour), String(params.minute))) {
      throw new Error(AUTOMATION_TIME_PAST_MESSAGE);
    }
    const atTime = buildAtTime(
      params.date,
      String(params.hour),
      String(params.minute),
    );
    return { ...base, atTime };
  }

  if (params.freq === "now") {
    return { ...base, atTime: nowDate().toISOString() };
  }

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
  return { ...base, cronExpression };
}

export interface ZeroAutomationSaveParams {
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
  /** Automation name when editing an existing automation */
  editName?: string;
}

// ---------------------------------------------------------------------------
// All-org automation entries (for automations page — no agent filter)
// ---------------------------------------------------------------------------

export interface OrgAutomationEntry {
  id: string;
  time: string;
  prompt: string;
  description: string | null;
  enabled: boolean;
  name: string;
  /** IANA timezone used for display (user's preferred timezone) */
  timezone: string;
  intervalSeconds: number | null;
  agentId: string;
  displayName: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  chatThreadId: string;
  triggerCount: number;
  triggerKinds: PlatformAutomationView["triggerKinds"];
  triggerBadges: {
    id: string;
    kind: PlatformAutomationView["triggerKinds"][number];
  }[];
  triggerEditable: boolean;
  triggerReadOnlyReason: PlatformAutomationView["triggerReadOnlyReason"];
  triggerSummary: string;
}

const internalAllAutomations$ = state<PlatformAutomationView[]>([]);
const internalAllAutomationsLoaded$ = state(false);

/** True after the first successful org automation fetch has completed. */
export const allOrgAutomationsLoaded$ = computed((get) => {
  return get(internalAllAutomationsLoaded$);
});

export const allOrgAutomationEntries$ = computed(async (get) => {
  const automations = get(internalAllAutomations$);
  const prefs = await get(userPreferences$);
  const displayTz =
    prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...automations]
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((s): OrgAutomationEntry => {
      const triggerSummary = automationToTimeString(s, displayTz);
      return {
        id: s.id,
        time: triggerSummary,
        prompt: s.prompt,
        description: s.description,
        enabled: s.enabled,
        name: s.name,
        timezone: displayTz,
        intervalSeconds: s.intervalSeconds,
        agentId: s.agentId,
        displayName: s.displayName,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        chatThreadId: s.chatThreadId,
        triggerCount: s.triggerCount,
        triggerKinds: s.triggerKinds,
        triggerBadges: s.triggers.map((trigger) => {
          return { id: trigger.id, kind: trigger.kind };
        }),
        triggerEditable: s.triggerEditable,
        triggerReadOnlyReason: s.triggerReadOnlyReason,
        triggerSummary,
      };
    });
});

export const fetchAllOrgAutomations$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = get(featureSwitch$);
    const automations = await listAutomations(
      get(zeroClient$),
      {
        signal,
      },
      {
        includeUnsupported:
          features[FeatureSwitchKey.AutomationMultiTrigger] ?? false,
      },
    ).finally(() => {
      set(internalAllAutomationsLoaded$, true);
    });
    signal.throwIfAborted();
    set(internalAllAutomations$, automations);
  },
);

export const saveOrgAutomation$ = command(
  async (
    { get, set },
    params: ZeroAutomationSaveParams & { agentId: string },
    signal: AbortSignal,
  ) => {
    let automationId: string;
    try {
      const body = buildAutomationFormBody(params.agentId, params);

      const result = await deployAutomation(
        get(zeroClient$),
        body,
        params.editName !== undefined,
        {
          requireEditableTrigger:
            get(featureSwitch$)[FeatureSwitchKey.AutomationMultiTrigger] ??
            false,
        },
      );
      signal.throwIfAborted();
      automationId = result.id;
    } catch (error: unknown) {
      throwIfAbort(error);
      if (!(error instanceof ApiError)) {
        const message = error instanceof Error ? error.message : "Save failed";
        toast.error(message);
        if (message === AUTOMATION_TIME_PAST_MESSAGE) {
          throw markDetachedErrorHandled(error);
        }
      }
      throw error;
    }
    signal.throwIfAborted();

    toast.success(
      params.editName ? "Automation updated" : "Automation created",
    );
    await set(fetchAllOrgAutomations$, signal);

    return automationId;
  },
);

export const updateOrgAutomationIntent$ = command(
  async (
    { get, set },
    params: {
      id: string;
      prompt?: string;
      description?: string | null;
    },
    signal: AbortSignal,
  ) => {
    await updateAutomationIntent(get(zeroClient$), params);
    signal.throwIfAborted();

    toast.success("Automation updated");
    await set(fetchAllOrgAutomations$, signal);
  },
);

export const toggleOrgAutomationEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean; agentId: string },
    signal: AbortSignal,
  ) => {
    await setAutomationEnabled(get(zeroClient$), {
      name: params.name,
      agentId: params.agentId,
      enabled: params.enabled,
    });
    signal.throwIfAborted();

    await set(fetchAllOrgAutomations$, signal);
  },
);

export const deleteOrgAutomation$ = command(
  async (
    { get, set },
    params: { name: string; agentId: string },
    signal: AbortSignal,
  ) => {
    await deleteAutomation(get(zeroClient$), {
      name: params.name,
      agentId: params.agentId,
    });
    signal.throwIfAborted();

    toast.success("Automation deleted");
    await set(fetchAllOrgAutomations$, signal);
  },
);

/**
 * Execute an automation immediately (same pipeline as the cron trigger).
 * Returns the created run ID.
 */
export const runAutomationNow$ = command(
  async (
    { get },
    automationId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const toastId = toast.loading("Starting run…");
    signal.addEventListener("abort", () => {
      return toast.dismiss(toastId);
    });
    let runId: string;
    try {
      runId = await runAutomationNowApi(get(zeroClient$), automationId);
      signal.throwIfAborted();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Run failed";
      toast.error(message, { id: toastId });
      throw error;
    }
    signal.throwIfAborted();

    toast.success(
      createElement(
        "span",
        null,
        "Run started. ",
        createElement(
          Link,
          {
            pathname: "/activities/:activityRunId" as const,
            options: { pathParams: { activityRunId: runId } },
            className: "underline",
          },
          "View activity",
        ),
      ),
      { id: toastId },
    );

    return runId;
  },
);
