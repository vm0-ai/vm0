import type { ConnectorConfig } from "../connectors";

export const totalis = {
  totalis: {
    label: "Totalis",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Totalis account to access prediction-market derivatives and trading APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Totalis account\n2. Follow the [Totalis API docs](https://docs.totalis.trade/api-reference/introduction) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["TOTALIS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TOTALIS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-totalis-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TOTALIS_API_KEY: "$secrets.TOTALIS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
