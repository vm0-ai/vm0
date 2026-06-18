import type { ConnectorConfig } from "../connectors";

export const oddpool = {
  oddpool: {
    label: "Oddpool",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Oddpool account to access prediction-market data APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Oddpool account\n2. Follow the [Oddpool API docs](https://docs.oddpool.com/llms.txt) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["ODDPOOL_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ODDPOOL_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-oddpool-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ODDPOOL_API_KEY: "$secrets.ODDPOOL_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
