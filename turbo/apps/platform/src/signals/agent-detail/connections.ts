import { computed, state, command } from "ccstate";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/core";
import { agentDetail$ } from "./agent-detail.ts";
import { connectors$ } from "../external/connectors.ts";
import { secrets$ } from "../settings-page/secrets.ts";

// ---------------------------------------------------------------------------
// Agent required env — derived from compose content
// ---------------------------------------------------------------------------

interface AgentRequiredEnv {
  requiredSecrets: string[];
  requiredVariables: string[];
}

const agentRequiredEnv$ = computed((get): AgentRequiredEnv => {
  const detail = get(agentDetail$);
  if (!detail?.content?.agents) {
    return { requiredSecrets: [], requiredVariables: [] };
  }

  const agentDefs = Object.values(detail.content.agents);
  const firstAgent = agentDefs[0];

  if (!firstAgent?.environment) {
    return { requiredSecrets: [], requiredVariables: [] };
  }

  const refs = extractVariableReferences(firstAgent.environment);
  const grouped = groupVariablesBySource(refs);

  return {
    requiredSecrets: [
      ...grouped.secrets.map((r) => r.name),
      ...grouped.credentials.map((r) => r.name),
    ],
    requiredVariables: grouped.vars.map((r) => r.name),
  };
});

// ---------------------------------------------------------------------------
// Connector status — which connectors the agent needs
// ---------------------------------------------------------------------------

export interface AgentConnectorStatus {
  type: ConnectorType;
  label: string;
  helpText: string;
  connected: boolean;
  externalUsername: string | null;
}

export const agentConnectorStatus$ = computed(async (get) => {
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => type !== "computer")
    .map((type) => {
      const config = CONNECTOR_TYPES[type];
      const connector = connectorMap.get(type);
      return {
        type,
        label: config.label,
        helpText: config.helpText,
        connected: connector !== undefined,
        externalUsername: connector?.externalUsername ?? null,
      };
    });
});

// ---------------------------------------------------------------------------
// Secret status — which secrets the agent needs
// ---------------------------------------------------------------------------

export interface AgentSecretStatus {
  name: string;
  configured: boolean;
}

export const agentSecretStatus$ = computed(async (get) => {
  const { requiredSecrets } = get(agentRequiredEnv$);
  const configuredSecrets = await get(secrets$);
  const configuredNames = new Set(configuredSecrets.map((s) => s.name));

  // Hide secrets that connectors can provide
  const connectorEnvVars = getConnectorProvidedSecretNames(
    Object.keys(CONNECTOR_TYPES) as ConnectorType[],
  );

  return requiredSecrets
    .filter((name) => !connectorEnvVars.has(name))
    .map((name) => ({
      name,
      configured: configuredNames.has(name),
    }));
});

// ---------------------------------------------------------------------------
// Variable status — which variables the agent needs
// ---------------------------------------------------------------------------

export interface AgentVariableStatus {
  name: string;
  configured: boolean;
}

export const agentVariableStatus$ = computed((get) => {
  const { requiredVariables } = get(agentRequiredEnv$);

  // Variables are always "configured" since they're resolved from CLI --vars at runtime.
  // We show them for informational purposes.
  return requiredVariables.map((name) => ({
    name,
    configured: false,
  }));
});

// ---------------------------------------------------------------------------
// Active tab state
// ---------------------------------------------------------------------------

type ConnectionsTab = "connectors" | "secrets";

const internalActiveTab$ = state<ConnectionsTab>("connectors");

export const connectionsActiveTab$ = computed((get) => get(internalActiveTab$));

function isConnectionsTab(v: string): v is ConnectionsTab {
  return v === "connectors" || v === "secrets";
}

export const setConnectionsActiveTab$ = command(({ set }, v: string) => {
  if (isConnectionsTab(v)) {
    set(internalActiveTab$, v);
  }
});
