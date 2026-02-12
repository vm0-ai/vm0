import { computed } from "ccstate";
import {
  CONNECTOR_TYPES,
  getConnectorProvidedSecretNames,
  type ConnectorType,
  type SecretResponse,
  type VariableResponse,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { secrets$ } from "./secrets.ts";
import { variables$ } from "./variables.ts";

// ---------------------------------------------------------------------------
// Agent required env
// ---------------------------------------------------------------------------

interface AgentRequiredEnv {
  composeId: string;
  agentName: string;
  requiredSecrets: string[];
  requiredVariables: string[];
}

interface AgentRequiredEnvResponse {
  agents: AgentRequiredEnv[];
}

const agentRequiredEnv$ = computed(async (get) => {
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/agent/required-env");
  const data = (await resp.json()) as AgentRequiredEnvResponse;
  return data.agents;
});

const requiredSecretNames$ = computed(async (get) => {
  const agents = await get(agentRequiredEnv$);
  const names = new Set<string>();
  for (const agent of agents) {
    for (const name of agent.requiredSecrets) {
      names.add(name);
    }
  }
  return names;
});

const requiredVariableNames$ = computed(async (get) => {
  const agents = await get(agentRequiredEnv$);
  const names = new Set<string>();
  for (const agent of agents) {
    for (const name of agent.requiredVariables) {
      names.add(name);
    }
  }
  return names;
});

// ---------------------------------------------------------------------------
// Merged items
// ---------------------------------------------------------------------------

export type MergedItem =
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

export const mergedItems$ = computed(async (get) => {
  const [secretsList, variablesList, reqSecrets, reqVariables] =
    await Promise.all([
      get(secrets$),
      get(variables$),
      get(requiredSecretNames$),
      get(requiredVariableNames$),
    ]);

  // Secret names that ANY connector can provide (e.g. NOTION_TOKEN, GH_TOKEN).
  // Used to hide missing secrets that should be resolved via connectors tab.
  // Secret names that ANY connector can provide (e.g. NOTION_TOKEN, GH_TOKEN).
  // These are hidden from missing items and always deletable when configured,
  // since the user should resolve them via the connectors tab.
  const allConnectorEnvVars = getConnectorProvidedSecretNames(
    Object.keys(CONNECTOR_TYPES) as ConnectorType[],
  );

  const items: MergedItem[] = [];

  const configuredSecretNames = new Set(secretsList.map((s) => s.name));
  const configuredVariableNames = new Set(variablesList.map((v) => v.name));

  // Missing required secrets (not yet configured, not resolvable by any connector)
  for (const name of reqSecrets) {
    if (!configuredSecretNames.has(name) && !allConnectorEnvVars.has(name)) {
      items.push({ kind: "secret", name, data: null, agentRequired: true });
    }
  }

  // Missing required variables (not yet configured)
  for (const name of reqVariables) {
    if (!configuredVariableNames.has(name)) {
      items.push({ kind: "variable", name, data: null, agentRequired: true });
    }
  }

  // Configured secrets
  // Agent-required but connector-resolvable → treat as deletable (not agentRequired)
  for (const secret of secretsList) {
    const required = reqSecrets.has(secret.name);
    items.push({
      kind: "secret",
      name: secret.name,
      data: secret,
      agentRequired: required && !allConnectorEnvVars.has(secret.name),
    });
  }

  // Configured variables
  for (const variable of variablesList) {
    items.push({
      kind: "variable",
      name: variable.name,
      data: variable,
      agentRequired: reqVariables.has(variable.name),
    });
  }

  return items;
});
