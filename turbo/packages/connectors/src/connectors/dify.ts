import type { ConnectorConfig } from "../connectors";

export const dify = {
  dify: {
    label: "Dify",
    category: "ai-agent-apps",
    generation: ["text"],
    helpText:
      "Connect your Dify account to build and manage AI-powered workflows, chatbots, and agentic applications",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dify](https://cloud.dify.ai)\n2. Open your app and navigate to **API Access** in the left sidebar\n3. Click to generate new API credentials\n4. Copy the API key",
        grant: {
          kind: "manual",
          fields: {
            DIFY_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "app-...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            DIFY_TOKEN: "$secrets.DIFY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
