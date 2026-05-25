import type { ConnectorConfig } from "../connectors";

export const whaleAlert = {
  "whale-alert": {
    label: "Whale Alert",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Whale Alert developer account to access blockchain transaction data and custom whale alert APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Create a Whale Alert developer account\n2. Subscribe to the Custom Alerts or Enterprise REST API plan\n3. Copy the API key provided for your subscription\n4. Use this key as the `api_key` query parameter",
        grant: {
          kind: "manual",
          fields: {
            WHALE_ALERT_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "Coffee5afe10ca1Coffee5afe10ca1Co",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            WHALE_ALERT_API_KEY: "$secrets.WHALE_ALERT_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
