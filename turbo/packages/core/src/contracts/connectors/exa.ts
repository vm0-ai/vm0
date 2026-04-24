import type { ConnectorConfig } from "../connectors";

export const exa = {
  exa: {
    label: "Exa",
    category: "data-automation-infrastructure",
    environmentMapping: {
      EXA_TOKEN: "$secrets.EXA_TOKEN",
    },
    helpText:
      "Connect your Exa account to perform AI-native semantic web search, retrieve page contents, and find similar pages",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [dashboard.exa.ai](https://dashboard.exa.ai)\n2. Click your account \u2192 **API Keys** \u2192 **Create API Key**\n3. Copy the key (starts with `exa_`). Free tier: 1,000 requests/month.",
        secrets: {
          EXA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "exa_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
