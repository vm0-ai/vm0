import type { ConnectorConfig } from "../connectors";

export const voquill = {
  voquill: {
    label: "Voquill",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Voquill account to access medical lab workflow APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Voquill account\n2. Follow the [Voquill API docs](https://docs.voquill.com/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["VOQUILL_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            VOQUILL_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-voquill-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            VOQUILL_API_KEY: "$secrets.VOQUILL_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
