import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import type { ComposeListItem } from "@vm0/core";

const L = logger("AgentsList");

interface Schedule {
  name: string;
  composeName: string;
  enabled: boolean;
  cronExpression?: string;
  atTime?: string;
  timezone: string;
}

interface AgentMissingSecrets {
  composeId: string;
  agentName: string;
  requiredSecrets: string[];
  missingSecrets: string[];
}

interface AgentsListState {
  agents: ComposeListItem[];
  schedules: Schedule[];
  agentsWithMissingSecrets: AgentMissingSecrets[];
  loading: boolean;
  error: string | null;
}

const agentsListState$ = state<AgentsListState>({
  agents: [],
  schedules: [],
  agentsWithMissingSecrets: [],
  loading: false,
  error: null,
});

export const agentsList$ = computed((get) => get(agentsListState$).agents);
export const schedules$ = computed((get) => get(agentsListState$).schedules);
export const agentsWithMissingSecrets$ = computed(
  (get) => get(agentsListState$).agentsWithMissingSecrets,
);
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
      // Log schedule fetch errors for debugging, but don't fail the page
      L.error("Failed to fetch schedules:", error);
    }

    // Fetch agents with missing secrets (optional)
    let agentsWithMissingSecrets: AgentMissingSecrets[] = [];
    try {
      const missingSecretsResponse = await fetchFn(
        "/api/agent/schedules/missing-secrets",
      );
      if (missingSecretsResponse.ok) {
        const missingSecretsData = (await missingSecretsResponse.json()) as {
          agents: AgentMissingSecrets[];
        };
        agentsWithMissingSecrets = missingSecretsData.agents;
      }
    } catch (error) {
      throwIfAbort(error);
      // Log missing secrets fetch errors for debugging, but don't fail the page
      L.error("Failed to fetch agents with missing secrets:", error);
    }

    set(agentsListState$, {
      agents: agentsData.composes,
      schedules,
      agentsWithMissingSecrets,
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
