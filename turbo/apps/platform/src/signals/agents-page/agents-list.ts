import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import type { ComposeListItem } from "@vm0/core";

interface Schedule {
  name: string;
  composeName: string;
  enabled: boolean;
  cronExpression?: string;
  atTime?: string;
  timezone: string;
}

interface AgentsListState {
  agents: ComposeListItem[];
  schedules: Schedule[];
  loading: boolean;
  error: string | null;
}

const agentsListState$ = state<AgentsListState>({
  agents: [],
  schedules: [],
  loading: false,
  error: null,
});

export const agentsList$ = computed((get) => get(agentsListState$).agents);
export const schedules$ = computed((get) => get(agentsListState$).schedules);
export const agentsLoading$ = computed((get) => get(agentsListState$).loading);
export const agentsError$ = computed((get) => get(agentsListState$).error);

// Helper to check if an agent has a schedule
export const getAgentScheduleStatus = (
  agentName: string,
  schedules: Schedule[],
): boolean => {
  return schedules.some(
    (schedule) => schedule.composeName === agentName && schedule.enabled,
  );
};

export const fetchAgentsList$ = command(async ({ get, set }) => {
  set(agentsListState$, (prev) => ({ ...prev, loading: true, error: null }));

  try {
    const fetchFn = get(fetch$);

    // Fetch agents (required)
    const agentsResponse = await fetchFn("/api/agent/composes/list");

    if (!agentsResponse.ok) {
      throw new Error(`Failed to fetch agents: ${agentsResponse.statusText}`);
    }

    const agentsData = (await agentsResponse.json()) as {
      composes: ComposeListItem[];
    };

    // Fetch schedules (optional - don't fail if schedules API is unavailable)
    let schedules: Schedule[] = [];
    try {
      const schedulesResponse = await fetchFn("/api/agent/schedules");
      if (schedulesResponse.ok) {
        const schedulesData = (await schedulesResponse.json()) as {
          schedules: Schedule[];
        };
        schedules = schedulesData.schedules;
      }
    } catch (error) {
      throwIfAbort(error);
      // Silently ignore schedule fetch errors - schedules are optional
    }

    set(agentsListState$, {
      agents: agentsData.composes,
      schedules,
      loading: false,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    set(agentsListState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});
