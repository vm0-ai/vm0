import type { ConnectorConfig } from "../connectors";

export const qomplement = {
  qomplement: {
    label: "qomplement",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your qomplement account to access AI ERP and supply-chain APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your qomplement account\n2. Follow the [qomplement API docs](https://docs.qomplement.com/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["QOMPLEMENT_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            QOMPLEMENT_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-qomplement-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            QOMPLEMENT_API_KEY: "$secrets.QOMPLEMENT_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
