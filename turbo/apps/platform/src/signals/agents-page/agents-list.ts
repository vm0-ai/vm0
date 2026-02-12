import { command, computed, state } from "ccstate";
import {
  getConnectorProvidedSecretNames,
  type ComposeListItem,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { connectors$ } from "../external/connectors.ts";
import { secrets$ } from "../settings-page/secrets.ts";
import { variables$ } from "../settings-page/variables.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("AgentsList");

interface Schedule {
  name: string;
  composeName: string;
  enabled: boolean;
  cronExpression?: string;
  atTime?: string;
  timezone: string;
}

export interface AgentMissingItems {
  composeId: string;
  agentName: string;
  missingSecrets: string[];
  missingVariables: string[];
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

// ---------------------------------------------------------------------------
// Missing items (computed from required-env + configured secrets/variables)
// ---------------------------------------------------------------------------

interface AgentRequiredEnv {
  composeId: string;
  agentName: string;
  requiredSecrets: string[];
  requiredVariables: string[];
}

const agentRequiredEnv$ = computed(async (get) => {
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/agent/required-env");
  if (!resp.ok) {
    return [];
  }
  const data = (await resp.json()) as { agents: AgentRequiredEnv[] };
  return data.agents;
});

/**
 * Per-agent missing items, computed client-side by comparing required env
 * against configured secrets, variables, and connected connectors.
 *
 * Automatically refreshes when secrets$, variables$, or connectors$ change.
 */
export const agentsMissingItems$ = computed(async (get) => {
  const [requiredEnv, secretsList, variablesList, connectorData] =
    await Promise.all([
      get(agentRequiredEnv$),
      get(secrets$),
      get(variables$),
      get(connectors$),
    ]);

  const configuredSecretNames = new Set(secretsList.map((s) => s.name));
  const configuredVariableNames = new Set(variablesList.map((v) => v.name));
  const connectedTypes = connectorData.connectors.map((c) => c.type);
  const connectorProvided = getConnectorProvidedSecretNames(connectedTypes);

  const result: AgentMissingItems[] = [];

  for (const agent of requiredEnv) {
    const missingSecrets = agent.requiredSecrets.filter(
      (name) =>
        !configuredSecretNames.has(name) && !connectorProvided.has(name),
    );
    const missingVariables = agent.requiredVariables.filter(
      (name) => !configuredVariableNames.has(name),
    );

    if (missingSecrets.length > 0 || missingVariables.length > 0) {
      result.push({
        composeId: agent.composeId,
        agentName: agent.agentName,
        missingSecrets,
        missingVariables,
      });
    }
  }

  return result;
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
