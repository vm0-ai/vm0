import type { ConnectorConfig } from "../connectors";

export const salesgraph = {
  salesgraph: {
    label: "Salesgraph",
    category: "sales-crm-business-operations",
    helpText: "Connect your Salesgraph account to access revenue agent APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Salesgraph account\n2. Follow the [Salesgraph API docs](https://docs.salesgraph.com) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["SALESGRAPH_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SALESGRAPH_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-salesgraph-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SALESGRAPH_API_KEY: "$secrets.SALESGRAPH_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
