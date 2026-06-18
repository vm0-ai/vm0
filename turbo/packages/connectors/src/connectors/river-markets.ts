import type { ConnectorConfig } from "../connectors";

export const riverMarkets = {
  "river-markets": {
    label: "River Markets",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your River Markets account to access prediction-market execution and data APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your River Markets account\n2. Follow the [River Markets API docs](https://docs.rivermarkets.com/introduction) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["RIVER_MARKETS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RIVER_MARKETS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-river-markets-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RIVER_MARKETS_API_KEY: "$secrets.RIVER_MARKETS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
