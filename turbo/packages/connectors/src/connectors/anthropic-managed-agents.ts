import type { ConnectorConfig } from "../connectors";

export const anthropicManagedAgents = {
  "anthropic-managed-agents": {
    label: "Anthropic Managed Agents",
    category: "ai-agent-apps",
    helpText:
      "Connect to Anthropic Managed Agents API to programmatically create and run AI agents in cloud environments",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [Anthropic Console](https://console.anthropic.com)\n2. Go to **API Keys** and create a new key\n3. Ensure your account has Managed Agents (beta) access\n4. Copy the API key (starts with `sk-ant-`)",
        grant: {
          kind: "manual",
          fields: {
            ANTHROPIC_MANAGED_AGENTS_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk-ant-api03-...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            ANTHROPIC_MANAGED_AGENTS_TOKEN:
              "$secrets.ANTHROPIC_MANAGED_AGENTS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
