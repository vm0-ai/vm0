import { command, computed, state } from "ccstate";
import type { ComposeListItem } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("AgentsList");

interface Schedule {
  name: string;
  agentId: string;
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
export const agentsLoading$ = computed((get) => get(agentsListState$).loading);
export const agentsError$ = computed((get) => get(agentsListState$).error);

export const fetchAgentsList$ = command(async ({ get, set }) => {
  set(agentsListState$, (prev) => ({ ...prev, loading: true, error: null }));

  try {
    const fetchFn = get(fetch$);

    // Fetch agents from app team endpoint (uses Clerk active org)
    const agentsResponse = await fetchFn("/api/zero/team");

    if (!agentsResponse.ok) {
      throw new Error(`Failed to fetch agents: ${agentsResponse.statusText}`);
    }

    const agentsData = (await agentsResponse.json()) as {
      composes: ComposeListItem[];
    };

    // Fetch schedules (optional - don't fail if schedules API is unavailable)
    let schedules: Schedule[] = [];
    try {
      const schedulesResponse = await fetchFn("/api/zero/schedules");
      if (schedulesResponse.ok) {
        const schedulesData = (await schedulesResponse.json()) as {
          schedules: Schedule[];
        };
        schedules = schedulesData.schedules;
      }
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch schedules:", error);
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
