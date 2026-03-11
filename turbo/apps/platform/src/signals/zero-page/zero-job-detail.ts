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
}

const instructionsState$ = state<ZeroJobInstructionsState>({
  instructions: null,
  loading: false,
});

export const zeroJobInstructions$ = computed(
  (get) => get(instructionsState$).instructions,
);
export const zeroJobInstructionsLoading$ = computed(
  (get) => get(instructionsState$).loading,
);

const fetchZeroJobInstructions$ = command(async ({ get, set }) => {
  const detail = get(zeroJobDetail$);
  if (!detail) {
    return;
  }

  set(instructionsState$, { instructions: null, loading: true });

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/composes/${detail.id}/instructions`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch instructions: ${response.statusText}`);
    }

    const data = (await response.json()) as AgentInstructions;
    set(instructionsState$, { instructions: data, loading: false });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch instructions:", error);
    set(instructionsState$, { instructions: null, loading: false });
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

const scheduleState$ = state<ScheduleItem[]>([]);
export const zeroJobSchedule$ = computed((get) => get(scheduleState$));

const fetchZeroJobSchedule$ = command(async ({ get, set }) => {
  const name = get(internalAgentName$);
  if (!name) {
    return;
  }

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/agent/schedules");
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as { schedules: ScheduleItem[] };
    const agentSchedules = data.schedules.filter((s) => s.composeName === name);
    set(scheduleState$, agentSchedules);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch schedules:", error);
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
