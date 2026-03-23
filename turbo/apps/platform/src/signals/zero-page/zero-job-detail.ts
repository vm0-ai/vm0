import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { search } from "../location.ts";
import type { AgentDetail, AgentInstructions } from "./agent-types.ts";
import {
  buildCronExpression,
  buildAtTime,
  isAtTimePast,
  type ScheduleBody,
  type CronTimeOption,
} from "./cron.ts";
import { fetchAgentsList$ } from "./zero-agents.ts";
import { reloadZeroCompose$ } from "./zero-connectors.ts";
import type { ScheduleEntry } from "../../views/zero-page/zero-schedule-card.tsx";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Agent name — set when navigating to a subagent detail page
// ---------------------------------------------------------------------------

const internalAgentName$ = state<string | null>(null);
const setZeroJobAgentName$ = command(({ set }, name: string | null) => {
  set(internalAgentName$, name);
});

// ---------------------------------------------------------------------------
// Active tab
// ---------------------------------------------------------------------------

function isValidTab(tab: string): boolean {
  return (
    tab === "connectors" ||
    tab === "schedule" ||
    tab === "profile" ||
    tab === "instructions"
  );
}

function getInitialTab(): string {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : "connectors";
}

const internalActiveTab$ = state("connectors");

export const zeroJobActiveTab$ = computed((get) => get(internalActiveTab$));

export const setZeroJobActiveTab$ = command(({ set }, tab: string) => {
  set(internalActiveTab$, tab);
  const url = new URL(location.href);
  if (tab === "connectors") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tab);
  }
  history.replaceState(null, "", url.toString());
});

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

interface ZeroJobDetailState {
  detail: AgentDetail | null;
  loading: boolean;
  error: string | null;
}

const detailState$ = state<ZeroJobDetailState>({
  detail: null,
  loading: false,
  error: null,
});

export const zeroJobDetail$ = computed((get) => get(detailState$).detail);
export const zeroJobDetailLoading$ = computed(
  (get) => get(detailState$).loading,
);
export const zeroJobDetailError$ = computed((get) => get(detailState$).error);

const fetchZeroJobDetail$ = command(async ({ get, set }) => {
  const name = get(internalAgentName$);
  if (!name) {
    return;
  }

  set(detailState$, (prev) => ({ ...prev, loading: true, error: null }));

  try {
    const fetchFn = get(fetch$);

    const response = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(name)}`,
    );
    if (!response.ok) {
      const status = response.status;
      const text = response.statusText || `HTTP ${status}`;
      throw new Error(`Failed to fetch agent: ${text} (${status})`);
    }

    const data = (await response.json()) as AgentDetail;

    set(detailState$, {
      detail: data,
      loading: false,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch agent detail:", error);
    set(detailState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

// ---------------------------------------------------------------------------
// Agent instructions
// ---------------------------------------------------------------------------

interface ZeroJobInstructionsState {
  instructions: AgentInstructions | null;
  loading: boolean;
  error: string | null;
}

const instructionsState$ = state<ZeroJobInstructionsState>({
  instructions: null,
  loading: false,
  error: null,
});

export const zeroJobInstructions$ = computed(
  (get) => get(instructionsState$).instructions,
);
export const zeroJobInstructionsLoading$ = computed(
  (get) => get(instructionsState$).loading,
);
export const zeroJobInstructionsError$ = computed(
  (get) => get(instructionsState$).error,
);

const fetchZeroJobInstructions$ = command(async ({ get, set }) => {
  const detail = get(zeroJobDetail$);
  if (!detail) {
    return;
  }

  set(instructionsState$, { instructions: null, loading: true, error: null });

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(detail.name)}/instructions`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch instructions: ${response.statusText}`);
    }

    const data = (await response.json()) as AgentInstructions;
    set(instructionsState$, {
      instructions: data,
      loading: false,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch instructions:", error);
    set(instructionsState$, {
      instructions: null,
      loading: false,
      error:
        error instanceof Error ? error.message : "Failed to load instructions",
    });
  }
});

// ---------------------------------------------------------------------------
// Instructions editing
// ---------------------------------------------------------------------------

const editedContent$ = state<string | null>(null);

export const zeroJobEditedContent$ = computed((get) => get(editedContent$));

export const zeroJobInstructionsDirty$ = computed((get) => {
  const edited = get(editedContent$);
  const instructions = get(instructionsState$).instructions;
  const savedBody = instructions?.content ?? "";
  return edited !== null && edited.trim() !== savedBody.trim();
});

export const setZeroJobEditedContent$ = command(({ set }, value: string) => {
  set(editedContent$, value);
});

export const discardZeroJobEdit$ = command(({ set }) => {
  set(editedContent$, null);
});

const jobBuilding$ = state(false);
export const zeroJobBuilding$ = computed((get) => get(jobBuilding$));

const internalBuildError$ = state<string | null>(null);
export const zeroJobBuildError$ = computed((get) => get(internalBuildError$));

export const buildZeroJobInstructions$ = command(async ({ get, set }) => {
  const detail = get(zeroJobDetail$);
  const raw = get(editedContent$);
  if (!detail?.name || raw === null) {
    return;
  }
  const edited = raw.trim();

  set(jobBuilding$, true);
  set(internalBuildError$, null);

  try {
    const fetchFn = get(fetch$);

    const resp = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(detail.name)}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: edited }),
      },
    );

    if (!resp.ok) {
      const errorData = (await resp.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Build failed: ${resp.statusText}`,
      );
    }

    // Optimistically update instructions state
    const current = get(instructionsState$).instructions;
    set(instructionsState$, {
      instructions: { content: edited, filename: current?.filename ?? null },
      loading: false,
      error: null,
    });

    set(editedContent$, null);
    await set(fetchZeroJobDetail$);
  } catch (error) {
    throwIfAbort(error);
    set(internalBuildError$, "Failed to build instructions. Please try again.");
  } finally {
    set(jobBuilding$, false);
  }
});

// ---------------------------------------------------------------------------
// Settings: update agent metadata (displayName, sound)
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const zeroJobSettingsSaving$ = computed((get) => get(internalSaving$));

interface ZeroJobSettingsUpdate {
  displayName?: string;
  description?: string;
  sound?: string;
}

export const zeroJobUpdateSettings$ = command(
  async ({ get, set }, update: ZeroJobSettingsUpdate) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No compose detail found");
    }

    set(internalSaving$, true);
    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn(
        `/api/zero/agents/${encodeURIComponent(detail.name)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      await set(fetchZeroJobDetail$);
      await set(fetchAgentsList$);
      toast.success("Profile saved");
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to update settings:", error);
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      set(internalSaving$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// Connectors management
// ---------------------------------------------------------------------------

const internalAddedConnectors$ = state<string[] | null>(null);

const seededConnectors$ = computed((get) => {
  const detail = get(zeroJobDetail$);
  return detail?.connectors ?? [];
});

export const zeroJobAddedConnectors$ = computed((get) => {
  const local = get(internalAddedConnectors$);
  if (local !== null) {
    return local;
  }
  return get(seededConnectors$);
});

export const zeroJobConnectorsDirty$ = computed((get) => {
  const local = get(internalAddedConnectors$);
  if (local === null) {
    return false;
  }
  const seeded = get(seededConnectors$);
  if (local.length !== seeded.length) {
    return true;
  }
  const sorted = [...local].sort();
  const seededSorted = [...seeded].sort();
  return sorted.some((s, i) => s !== seededSorted[i]);
});

export const addZeroJobConnector$ = command(({ get, set }, name: string) => {
  if (get(internalAddedConnectors$) === null) {
    set(internalAddedConnectors$, get(seededConnectors$));
  }
  set(internalAddedConnectors$, (prev) => [...(prev ?? []), name]);
});

export const removeZeroJobConnector$ = command(({ get, set }, name: string) => {
  if (get(internalAddedConnectors$) === null) {
    set(internalAddedConnectors$, get(seededConnectors$));
  }
  set(internalAddedConnectors$, (prev) =>
    (prev ?? []).filter((s) => s !== name),
  );
});

export const discardZeroJobConnectors$ = command(({ set }) => {
  set(internalAddedConnectors$, null);
});

export const saveZeroJobConnectors$ = command(async ({ get, set }) => {
  const detail = get(zeroJobDetail$);
  if (!detail?.name) {
    throw new Error("No agent detail loaded");
  }

  set(internalSaving$, true);
  try {
    const newConnectors = get(internalAddedConnectors$) ?? [];
    const fetchFn = get(fetch$);

    const resp = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(detail.name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: newConnectors }),
      },
    );

    if (!resp.ok) {
      const errorData = (await resp.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Save failed: ${resp.statusText}`,
      );
    }

    set(internalAddedConnectors$, null);
    await set(fetchZeroJobDetail$);
    set(reloadZeroCompose$);
    toast.success("Connectors saved");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to save connectors:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to save connectors",
    );
  } finally {
    set(internalSaving$, false);
  }
});

// ---------------------------------------------------------------------------
// Agent schedule
// ---------------------------------------------------------------------------

interface ScheduleItem {
  id: string;
  composeId: string;
  composeName: string;
  name: string;
  enabled: boolean;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
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
      .map((d) => dayNames[d])
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

export const zeroJobScheduleEntries$ = computed((get) => {
  const items = get(scheduleState$).schedules;
  return [...items]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(
      (s): ScheduleEntry => ({
        id: s.id,
        time: scheduleToTimeString(s),
        prompt: s.prompt,
        enabled: s.enabled,
        name: s.name,
        intervalSeconds: s.intervalSeconds,
      }),
    );
});

export const zeroJobScheduleError$ = computed(
  (get) => get(scheduleState$).error,
);

const fetchZeroJobSchedule$ = command(async ({ get, set }) => {
  const name = get(internalAgentName$);
  if (!name) {
    return;
  }

  set(scheduleState$, { schedules: [], error: null });

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/zero/schedules");
    if (!response.ok) {
      throw new Error(`Failed to fetch schedules: ${response.statusText}`);
    }

    const data = (await response.json()) as { schedules: ScheduleItem[] };
    const agentSchedules = data.schedules.filter((s) => s.composeName === name);
    set(scheduleState$, { schedules: agentSchedules, error: null });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch schedules:", error);
    set(scheduleState$, {
      schedules: [],
      error:
        error instanceof Error ? error.message : "Failed to load schedules",
    });
  }
});

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

export interface ZeroJobScheduleSaveParams {
  prompt: string;
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
  async ({ get, set }, params: ZeroJobScheduleSaveParams) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const fetchFn = get(fetch$);
    const scheduleName = params.editName ?? `zero-${Date.now().toString(36)}`;

    const base = {
      composeId: detail.agentComposeId,
      name: scheduleName,
      timezone: params.timezone,
      prompt: params.prompt.trim(),
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

    const response = await fetchFn("/api/zero/schedules", {
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
    await set(fetchZeroJobSchedule$);
  },
);

export const toggleZeroJobScheduleEnabled$ = command(
  async ({ get, set }, params: { name: string; enabled: boolean }) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const fetchFn = get(fetch$);
    const action = params.enabled ? "enable" : "disable";
    const response = await fetchFn(
      `/api/zero/schedules/${encodeURIComponent(params.name)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeId: detail.agentComposeId }),
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

    await set(fetchZeroJobSchedule$);
  },
);

export const deleteZeroJobSchedule$ = command(
  async ({ get, set }, scheduleName: string) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No agent detail loaded");
    }

    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/zero/schedules/${encodeURIComponent(scheduleName)}?composeId=${encodeURIComponent(detail.agentComposeId)}`,
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
    await set(fetchZeroJobSchedule$);
  },
);

// ---------------------------------------------------------------------------
// Delete agent
// ---------------------------------------------------------------------------

export const deleteZeroJobAgent$ = command(async ({ get, set }) => {
  const detail = get(zeroJobDetail$);
  if (!detail) {
    throw new Error("No agent detail loaded");
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn(
    `/api/zero/agents/${encodeURIComponent(detail.name)}`,
    { method: "DELETE" },
  );

  if (response.status === 409) {
    throw new Error("Cannot delete agent while it is running");
  }

  if (!response.ok && response.status !== 204) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const errorData = (await response.json()) as {
        error?: { message?: string };
      };
      throw new Error(
        errorData?.error?.message ?? `Delete failed: ${response.statusText}`,
      );
    }
    throw new Error(`Delete failed: ${response.statusText}`);
  }

  toast.success("Agent deleted");
  await set(fetchAgentsList$);
});

// ---------------------------------------------------------------------------
// Combined fetch — loads detail, then instructions + schedule in parallel
// ---------------------------------------------------------------------------

export const fetchZeroJobData$ = command(async ({ set }, agentName: string) => {
  // Reset all state so the skeleton screen shows while loading new data
  set(detailState$, { detail: null, loading: false, error: null });
  set(instructionsState$, { instructions: null, loading: false, error: null });
  set(scheduleState$, { schedules: [], error: null });
  set(editedContent$, null);
  set(internalAddedConnectors$, null);
  set(internalBuildError$, null);
  set(jobBuilding$, false);
  set(internalSaving$, false);
  set(internalActiveTab$, getInitialTab());

  set(setZeroJobAgentName$, agentName);
  await set(fetchZeroJobDetail$);
  await Promise.all([
    set(fetchZeroJobInstructions$),
    set(fetchZeroJobSchedule$),
  ]);
});
