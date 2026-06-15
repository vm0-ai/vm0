import type { ConnectorConfig } from "../connectors";

export const massive = {
  massive: {
    label: "Massive (Polygon.io)",
    category: "data-automation-infrastructure",
    tags: ["polygon", "polygon.io", "market data", "stocks", "forex", "crypto"],
    helpText:
      "Connect your Massive account to access stock, options, forex, crypto, indices, and market reference data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Massive](https://massive.com)\n2. Open your dashboard and navigate to API keys\n3. Create or copy an API key for REST API access\n4. Copy the API key",
        storage: {
          secrets: ["MASSIVE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MASSIVE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-massive-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MASSIVE_TOKEN: "$secrets.MASSIVE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
