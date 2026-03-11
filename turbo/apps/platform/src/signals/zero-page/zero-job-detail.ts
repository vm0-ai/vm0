import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import type { AgentDetail, AgentInstructions } from "../agent-detail/types.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Agent name — set when navigating to a subagent detail page
// ---------------------------------------------------------------------------

const internalAgentName$ = state<string | null>(null);
const setZeroJobAgentName$ = command(({ set }, name: string | null) => {
  set(internalAgentName$, name);
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
    const slashIndex = name.indexOf("/");
    const isOwner = slashIndex === -1;
    const agentName = isOwner ? name : name.slice(slashIndex + 1);
    const scope = isOwner ? undefined : name.slice(0, slashIndex);

    const params = new URLSearchParams({ name: agentName });
    if (scope) {
      params.set("scope", scope);
    }

    const response = await fetchFn(`/api/agent/composes?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      id: string;
      name: string;
      headVersionId: string | null;
      content: AgentDetail["content"];
      createdAt: string;
      updatedAt: string;
    };

    set(detailState$, {
      detail: { ...data, isOwner },
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
      `/api/agent/composes/${detail.id}/instructions`,
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
// Agent schedule
// ---------------------------------------------------------------------------

interface ScheduleItem {
  id: string;
  composeName: string;
  name: string;
  enabled: boolean;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
  prompt: string;
}

interface ZeroJobScheduleState {
  schedules: ScheduleItem[];
  error: string | null;
}

const scheduleState$ = state<ZeroJobScheduleState>({
  schedules: [],
  error: null,
});
export const zeroJobSchedule$ = computed(
  (get) => get(scheduleState$).schedules,
);
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
    const response = await fetchFn("/api/agent/schedules");
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
// Combined fetch — loads detail, then instructions + schedule in parallel
// ---------------------------------------------------------------------------

export const fetchZeroJobData$ = command(async ({ set }, agentName: string) => {
  set(setZeroJobAgentName$, agentName);
  await set(fetchZeroJobDetail$);
  await Promise.all([
    set(fetchZeroJobInstructions$),
    set(fetchZeroJobSchedule$),
  ]);
});
