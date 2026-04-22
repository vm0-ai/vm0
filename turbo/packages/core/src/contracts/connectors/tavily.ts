import type { ConnectorConfig } from "../connectors";

export const tavily = {
  tavily: {
    label: "Tavily",
    environmentMapping: {
      TAVILY_TOKEN: "$secrets.TAVILY_TOKEN",
    },
    helpText:
      "Connect your Tavily account to perform AI-optimized web searches and content extraction",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [app.tavily.com](https://app.tavily.com/) and sign up for a free account\n2. After signing in, your API key will be available on the dashboard\n3. Copy the API key (it will start with `tvly-`)",
        secrets: {
          TAVILY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "tvly-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
