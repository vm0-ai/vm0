import type { ConnectorConfig } from "../connectors";

export const zep = {
  zep: {
    label: "Zep",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Zep for long-term memory and conversation history management in AI agents.",
    environmentMapping: { ZEP_TOKEN: "$secrets.ZEP_TOKEN" },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [app.getzep.com](https://app.getzep.com)\n2. Go to **Settings**\n3. Navigate to **API Keys**\n4. Click **Create API Key** and copy the key",
        secrets: {
          ZEP_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "z_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
