import { DEFAULT_PROFILE } from "@okouai/api-contracts/contracts/runners";

/**
 * Application-owned baseline for launching a product Agent.
 *
 * This definition intentionally contains ownership and defaults only. Dynamic
 * provider, Connector, Workflow, request, continuation, Storage, and routing
 * inputs stay at their existing service boundaries.
 */
export const APPLICATION_OWNED_AGENT_EXECUTION_PLAN = {
  framework: {
    owner: "model-provider",
    fallback: "claude-code",
  },
  environment: {
    owners: ["system-identity", "model-provider", "connector", "run"],
    legacyRemovedPrefixes: ["ZERO_"],
    runtimeOverrideKeys: [
      "CLI_PKG_URL",
      "OKOU_AGENT_ID",
      "OKOU_APP_URL",
      "OKOU_TOKEN",
    ],
    legacySerializedBindings: {
      agentId: "OKOU_AGENT_ID",
      token: "OKOU_TOKEN",
    },
  },
  runner: {
    group: {
      owner: "execution-routing-policy",
      fallback: null,
    },
    profile: {
      owner: "resource-policy",
      fallback: DEFAULT_PROFILE,
    },
  },
  instructions: {
    owner: "agent-storage",
    enabled: true,
  },
  storage: {
    owners: [
      "system",
      "connector",
      "workflow",
      "request",
      "continuation",
      "session-storage",
    ],
  },
} as const;
