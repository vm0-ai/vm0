import type { ConnectorConfig } from "../connectors";

export const defillama = {
  defillama: {
    label: "DefiLlama",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your DefiLlama Pro account to access authenticated DeFi analytics data and higher-rate-limit Pro API endpoints",
    authMethods: {
      "api-token": {
        label: "Pro API Key",
        helpText:
          "1. Subscribe to [DefiLlama Pro API](https://defillama.com/subscription)\n2. Open the [Pro API docs](https://defillama.com/pro-api/docs)\n3. Copy your Pro API key\n\nThis connector is for the DefiLlama Pro API key. Most free DefiLlama API endpoints do not require authentication.",
        grant: {
          kind: "manual",
          fields: {
            DEFILLAMA_TOKEN: {
              label: "Pro API Key",
              required: true,
              placeholder: "your-defillama-pro-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DEFILLAMA_TOKEN: "$secrets.DEFILLAMA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
