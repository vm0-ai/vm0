/* eslint-disable no-restricted-syntax */
// This file contains a large amount of TRACE_CACHE that needs to be cleaned up in subsequent modifications.
// Additionally, other files must not reference this file to implement file-level no-restricted-syntax operations.

import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { createElement } from "react";
import { Link } from "../../views/router/link.tsx";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { zeroClient$ } from "../api-client.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  type ScheduleBody,
  type CronTimeOption,
} from "./cron.ts";
import { accept, ApiError } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";
import { defaultAgentId$ } from "../agent.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalSchedules$ = state<ScheduleResponse[]>([]);

// Schedule tab saving state (used by ZeroScheduleTab to show loading during save)
const internalScheduleTabSaving$ = state(false);

export const scheduleTabSaving$ = computed((get) => {
  return get(internalScheduleTabSaving$);
});

export const setScheduleTabSaving$ = command(({ set }, value: boolean) => {
  set(internalScheduleTabSaving$, value);
});

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

// ---------------------------------------------------------------------------
// Exported schedule entries (display format)
// ---------------------------------------------------------------------------

interface ZeroScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  description: string | null;
  enabled: boolean;
  /** Original schedule name for API operations */
  name: string;
  /** IANA timezone stored on the server */
  timezone: string;
  /** Raw interval in seconds for loop schedules */
  intervalSeconds: number | null;
}

export const zeroScheduleEntries$ = computed((get) => {
  const schedules = get(internalSchedules$);
  return [...schedules]
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((s): ZeroScheduleEntry => {
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

// ---------------------------------------------------------------------------
// Fetch schedules for the default agent
// ---------------------------------------------------------------------------

export const fetchZeroSchedules$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
    const composeId = status.defaultAgentId;
    if (!composeId) {
      set(internalSchedules$, []);
      return;
    }

    const client = get(zeroClient$)(zeroSchedulesMainContract);
    const result = await accept(
      client.list({ fetchOptions: { signal } }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();

    // Filter schedules for this agent's composeId
    const agentSchedules = result.body.schedules.filter((s) => {
      return s.agentId === composeId;
    });
    set(internalSchedules$, agentSchedules);
  },
);

// ---------------------------------------------------------------------------
// Save schedule (create or update)
// ---------------------------------------------------------------------------

function buildScheduleBody(
  agentId: string,
  params: ZeroScheduleSaveParams,
): ScheduleBody {
  const scheduleName = params.editName ?? `zero-${Date.now().toString(36)}`;

  const base = {
    agentId,
    name: scheduleName,
    timezone: params.timezone,
    prompt: params.prompt.trim(),
    ...(params.description && { description: params.description.trim() }),
    enabled: true,
    ...(params.modelProviderId !== undefined && {
      modelProviderId: params.modelProviderId,
    }),
    ...(params.selectedModel !== undefined && {
      selectedModel: params.selectedModel,
    }),
  };

  if (params.freq === "every_n_minutes") {
    return { ...base, intervalSeconds: params.intervalSeconds };
  }

  if (params.freq === "once") {
    if (isAtTimePast(params.date, String(params.hour), String(params.minute))) {
      throw new Error("Scheduled time must be in the future");
    }
    const atTime = buildAtTime(
      params.date,
      String(params.hour),
      String(params.minute),
    );
    return { ...base, atTime };
  }

  if (params.freq === "now") {
    return { ...base, atTime: new Date().toISOString() };
  }

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
  return { ...base, cronExpression };
}

export interface ZeroScheduleSaveParams {
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
  /** Schedule name when editing an existing schedule */
  editName?: string;
  modelProviderId?: string | null;
  selectedModel?: string | null;
}

export const saveZeroSchedule$ = command(
  async ({ get, set }, params: ZeroScheduleSaveParams, signal: AbortSignal) => {
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!defaultAgentId) {
      throw new Error("No default agent configured");
    }

    const body = buildScheduleBody(defaultAgentId, params);

    const client = get(zeroClient$)(zeroSchedulesMainContract);
    await accept(client.deploy({ body }), [200, 201]);
    signal.throwIfAborted();

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchZeroSchedules$, signal);
  },
);

// ---------------------------------------------------------------------------
// Toggle schedule enabled/disabled
// ---------------------------------------------------------------------------

export const toggleZeroScheduleEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
    const composeId = status.defaultAgentId;
    if (!composeId) {
      throw new Error("No default agent configured");
    }

    const client = get(zeroClient$)(zeroSchedulesEnableContract);
    const action = params.enabled ? "enable" : "disable";
    await accept(
      client[action]({
        params: { name: params.name },
        body: { agentId: composeId },
      }),
      [200],
    );
    signal.throwIfAborted();

    // Optimistic update: patch the local schedule state instead of refetching
    const current = get(internalSchedules$);
    set(
      internalSchedules$,
      current.map((s) => {
        return s.name === params.name ? { ...s, enabled: params.enabled } : s;
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Delete schedule
// ---------------------------------------------------------------------------

export const deleteZeroSchedule$ = command(
  async ({ get, set }, scheduleName: string, signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();
    const composeId = status.defaultAgentId;
    if (!composeId) {
      throw new Error("No default agent configured");
    }

    const client = get(zeroClient$)(zeroSchedulesByNameContract);
    await accept(
      client.delete({
        params: { name: scheduleName },
        query: { agentId: composeId },
      }),
      [204],
    );
    signal.throwIfAborted();

    toast.success("Schedule deleted");
    await set(fetchZeroSchedules$, signal);
  },
);

// ---------------------------------------------------------------------------
// All-org schedule entries (for schedule page — no agent filter)
// ---------------------------------------------------------------------------

export interface OrgScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  description: string | null;
  enabled: boolean;
  name: string;
  /** IANA timezone stored on the server */
  timezone: string;
  intervalSeconds: number | null;
  agentId: string;
  displayName: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  modelProviderId: string | null;
  selectedModel: string | null;
}

const internalAllSchedules$ = state<ScheduleResponse[]>([]);
const internalAllSchedulesLoaded$ = state(false);

/** True after the first successful org schedule fetch has completed. */
export const allOrgSchedulesLoaded$ = computed((get) => {
  return get(internalAllSchedulesLoaded$);
});

export const allOrgScheduleEntries$ = computed((get) => {
  const schedules = get(internalAllSchedules$);
  return [...schedules]
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((s): OrgScheduleEntry => {
      return {
        id: s.id,
        time: scheduleToTimeString(s),
        prompt: s.prompt,
        description: s.description,
        enabled: s.enabled,
        name: s.name,
        timezone: s.timezone,
        intervalSeconds: s.intervalSeconds,
        agentId: s.agentId,
        displayName: s.displayName,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        modelProviderId: s.modelProviderId,
        selectedModel: s.selectedModel,
      };
    });
});

export const fetchAllOrgSchedules$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroSchedulesMainContract);
    const result = await accept(
      client.list({ fetchOptions: { signal } }),
      [200],
      { toast: false },
    ).finally(() => {
      set(internalAllSchedulesLoaded$, true);
    });
    signal.throwIfAborted();
    set(internalAllSchedules$, result.body.schedules);
  },
);

export const saveOrgSchedule$ = command(
  async (
    { get, set },
    params: ZeroScheduleSaveParams & { agentId: string },
    signal: AbortSignal,
  ) => {
    let scheduleId: string;
    try {
      const body = buildScheduleBody(params.agentId, params);

      const client = get(zeroClient$)(zeroSchedulesMainContract);
      const result = await accept(client.deploy({ body }), [200, 201]);
      signal.throwIfAborted();
      scheduleId = result.body.schedule.id;
    } catch (error: unknown) {
      throwIfAbort(error);
      if (!(error instanceof ApiError)) {
        const message = error instanceof Error ? error.message : "Save failed";
        toast.error(message);
      }
      throw error;
    }
    signal.throwIfAborted();

    toast.success(params.editName ? "Schedule updated" : "Schedule created");
    await set(fetchAllOrgSchedules$, signal);

    return scheduleId;
  },
);

export const toggleOrgScheduleEnabled$ = command(
  async (
    { get, set },
    params: { name: string; enabled: boolean; agentId: string },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroSchedulesEnableContract);
    const action = params.enabled ? "enable" : "disable";
    await accept(
      client[action]({
        params: { name: params.name },
        body: { agentId: params.agentId },
      }),
      [200],
    );
    signal.throwIfAborted();

    await set(fetchAllOrgSchedules$, signal);
  },
);

export const deleteOrgSchedule$ = command(
  async (
    { get, set },
    params: { name: string; agentId: string },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroSchedulesByNameContract);
    await accept(
      client.delete({
        params: { name: params.name },
        query: { agentId: params.agentId },
      }),
      [204],
    );
    signal.throwIfAborted();

    toast.success("Schedule deleted");
    await set(fetchAllOrgSchedules$, signal);
  },
);

/**
 * Execute a schedule immediately (same pipeline as the cron trigger).
 * Returns the created run ID.
 */
export const runScheduleNow$ = command(
  async ({ get }, scheduleId: string, signal: AbortSignal): Promise<string> => {
    const toastId = toast.loading("Starting run…");
    signal.addEventListener("abort", () => {
      return toast.dismiss(toastId);
    });
    const client = get(zeroClient$)(zeroScheduleRunContract);
    let data: { runId: string };
    try {
      const result = await accept(client.run({ body: { scheduleId } }), [201], {
        toast: false,
      });
      signal.throwIfAborted();
      data = result.body;
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
            options: { pathParams: { activityRunId: data.runId } },
            className: "underline",
          },
          "View activity",
        ),
      ),
      { id: toastId },
    );

    return data.runId;
  },
);
