import { computed, state, command } from "ccstate";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
  CONNECTOR_TYPES,
  type ConnectorType,
  type SecretResponse,
  type VariableResponse,
} from "@vm0/core";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { agentDetail$ } from "./agent-detail.ts";
import { connectors$ } from "../external/connectors.ts";
import { secrets$ } from "../settings-page/secrets.ts";
import { variables$ } from "../settings-page/variables.ts";

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
// Merged item type — agent-scoped secrets & variables with requirement info
// ---------------------------------------------------------------------------

export type AgentMergedItem =
  | {
      kind: "secret";
      name: string;
      data: SecretResponse | null;
      agentRequired: boolean;
    }
  | {
      kind: "variable";
      name: string;
      data: VariableResponse | null;
      agentRequired: boolean;
    };

// ---------------------------------------------------------------------------
// Agent required connector types — derived from apps + environment mapping
// ---------------------------------------------------------------------------

export const agentRequiredConnectorTypes$ = computed(
  (get): Set<ConnectorType> => {
    const detail = get(agentDetail$);
    const required = new Set<ConnectorType>();

    if (!detail?.content?.agents) {
      return required;
    }

    const agentDefs = Object.values(detail.content.agents);
    const firstAgent = agentDefs[0];
    if (!firstAgent) {
      return required;
    }

    // From environment field — match env var names against connector environmentMappings
    if (firstAgent.environment) {
      const refs = extractVariableReferences(firstAgent.environment);
      const grouped = groupVariablesBySource(refs);
      const envVarNames = new Set([
        ...grouped.secrets.map((r) => r.name),
        ...grouped.credentials.map((r) => r.name),
      ]);

      for (const type of Object.keys(CONNECTOR_TYPES) as ConnectorType[]) {
        if (type === "computer") {
          continue;
        }
        const mapping = CONNECTOR_TYPES[type].environmentMapping ?? {};
        for (const envKey of Object.keys(mapping)) {
          if (envVarNames.has(envKey)) {
            required.add(type);
            break;
          }
        }
      }
    }

    return required;
  },
);

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
  const requiredTypes = get(agentRequiredConnectorTypes$);
  const { connectors } = await get(connectors$);
  const connectorMap = new Map(connectors.map((c) => [c.type, c]));

  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .filter((type) => requiredTypes.has(type))
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
// Merged items — secrets & variables scoped to the current agent
// ---------------------------------------------------------------------------

export const agentMergedItems$ = computed(async (get) => {
  const { requiredSecrets, requiredVariables } = get(agentRequiredEnv$);
  const [secretsList, variablesList] = await Promise.all([
    get(secrets$),
    get(variables$),
  ]);

  const allConnectorEnvVars = getConnectorProvidedSecretNames(
    Object.keys(CONNECTOR_TYPES) as ConnectorType[],
  );

  const items: AgentMergedItem[] = [];

  const configuredSecretNames = new Set(secretsList.map((s) => s.name));
  const configuredVariableNames = new Set(variablesList.map((v) => v.name));
  const requiredSecretSet = new Set(requiredSecrets);
  const requiredVariableSet = new Set(requiredVariables);

  // Missing required secrets (not yet configured, not resolvable by any connector)
  for (const name of requiredSecrets) {
    if (!configuredSecretNames.has(name) && !allConnectorEnvVars.has(name)) {
      items.push({ kind: "secret", name, data: null, agentRequired: true });
    }
  }

  // Missing required variables (not yet configured)
  for (const name of requiredVariables) {
    if (!configuredVariableNames.has(name)) {
      items.push({ kind: "variable", name, data: null, agentRequired: true });
    }
  }

  // Configured secrets that are required by this agent
  for (const secret of secretsList) {
    if (!requiredSecretSet.has(secret.name)) {
      continue;
    }
    items.push({
      kind: "secret",
      name: secret.name,
      data: secret,
      agentRequired: !allConnectorEnvVars.has(secret.name),
    });
  }

  // Configured variables that are required by this agent
  for (const variable of variablesList) {
    if (!requiredVariableSet.has(variable.name)) {
      continue;
    }
    items.push({
      kind: "variable",
      name: variable.name,
      data: variable,
      agentRequired: true,
    });
  }

  return items;
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

/**
 * Initialize tab state from URL search params.
 * Called during connections page setup.
 */
export const initConnectionsTabs$ = command(({ get, set }) => {
  const params = get(searchParams$);
  const tab = params.get("tab");
  if (tab && isConnectionsTab(tab)) {
    set(internalActiveTab$, tab);
  }
});

/**
 * Switch active tab and sync to URL.
 */
export const setConnectionsActiveTab$ = command(({ get, set }, tab: string) => {
  if (!isConnectionsTab(tab)) {
    return;
  }
  set(internalActiveTab$, tab);

  const params = new URLSearchParams(get(searchParams$));
  if (tab === "connectors") {
    params.delete("tab");
  } else {
    params.set("tab", tab);
  }
  set(updateSearchParams$, params);
});
