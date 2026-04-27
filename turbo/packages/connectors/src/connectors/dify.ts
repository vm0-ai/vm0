import type { ConnectorConfig } from "../connectors";

export const dify = {
  dify: {
    label: "Dify",
    category: "ai-agent-apps",
    environmentMapping: {
      DIFY_TOKEN: "$secrets.DIFY_TOKEN",
    },
    helpText:
      "Connect your Dify account to build and manage AI-powered workflows, chatbots, and agentic applications",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dify](https://cloud.dify.ai)\n2. Open your app and navigate to **API Access** in the left sidebar\n3. Click to generate new API credentials\n4. Copy the API key",
        secrets: {
          DIFY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "app-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
