import { command, computed, state } from "ccstate";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type ComposeListItem,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { connectors$ } from "../external/connectors.ts";
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

interface AgentMissingItems {
  composeId: string;
  agentName: string;
  requiredSecrets: string[];
  missingSecrets: string[];
  requiredVariables: string[];
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
// Missing items (separate reload trigger so it can refresh independently)
// ---------------------------------------------------------------------------

const internalReloadMissing$ = state(0);

const agentsMissingItems$ = computed(async (get) => {
  get(internalReloadMissing$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/agent/schedules/missing-secrets");
  if (!resp.ok) {
    return [];
  }
  const data = (await resp.json()) as { agents: AgentMissingItems[] };
  return data.agents;
});

/**
 * Reload missing items data (called after adding secrets/variables/connectors).
 */
export const reloadAgentsMissing$ = command(({ set }) => {
  set(internalReloadMissing$, (x) => x + 1);
});

// ---------------------------------------------------------------------------
// Env var → connector type mapping
// ---------------------------------------------------------------------------

function buildEnvVarToConnectorMap(): Readonly<Record<string, ConnectorType>> {
  const map: Record<string, ConnectorType> = {};
  for (const [type, config] of Object.entries(CONNECTOR_TYPES)) {
    for (const envVar of Object.keys(config.environmentMapping)) {
      map[envVar] = type as ConnectorType;
    }
  }
  return Object.freeze(map);
}

const ENV_VAR_TO_CONNECTOR = buildEnvVarToConnectorMap();

// ---------------------------------------------------------------------------
// Processed missing items per agent (connector-aware)
// ---------------------------------------------------------------------------

interface ConnectorMissingItem {
  connectorType: ConnectorType;
  label: string;
  secretNames: string[];
}

export interface AgentMissingInfo {
  agentName: string;
  /** Secrets not resolvable by any connector */
  manualSecrets: string[];
  /** Secrets resolvable by connecting a connector */
  connectorItems: ConnectorMissingItem[];
  /** Missing variables */
  missingVariables: string[];
}

/**
 * Processed map of agent name → missing info, accounting for connectors.
 */
export const agentsMissingInfo$ = computed(async (get) => {
  const items = await get(agentsMissingItems$);
  const { connectors } = await get(connectors$);
  const connectedTypes = new Set(connectors.map((c) => c.type));

  const result = new Map<string, AgentMissingInfo>();

  for (const item of items) {
    // Filter out secrets provided by connected connectors
    const trulyMissingSecrets = item.missingSecrets.filter((name) => {
      const connType = ENV_VAR_TO_CONNECTOR[name];
      return !connType || !connectedTypes.has(connType);
    });

    // Group connector-resolvable secrets by connector type
    const connectorGrouped: Partial<Record<ConnectorType, string[]>> = {};
    const manualSecrets: string[] = [];

    for (const name of trulyMissingSecrets) {
      const connType = ENV_VAR_TO_CONNECTOR[name];
      if (connType) {
        const list = connectorGrouped[connType] ?? [];
        list.push(name);
        connectorGrouped[connType] = list;
      } else {
        manualSecrets.push(name);
      }
    }

    const connectorItems: ConnectorMissingItem[] = [];
    for (const [connType, secretNames] of Object.entries(connectorGrouped)) {
      const config = CONNECTOR_TYPES[connType as ConnectorType];
      connectorItems.push({
        connectorType: connType as ConnectorType,
        label: config.label,
        secretNames,
      });
    }

    const missingVariables = item.missingVariables;

    if (
      manualSecrets.length > 0 ||
      connectorItems.length > 0 ||
      missingVariables.length > 0
    ) {
      result.set(item.agentName, {
        agentName: item.agentName,
        manualSecrets,
        connectorItems,
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

    // Missing items are now fetched reactively via agentsMissingInfo$ computed signal
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
