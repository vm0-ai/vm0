import type { ConnectorConfig } from "../connectors";

export const archer = {
  archer: {
    label: "Archer",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Archer account to access gifting, rewards, and payout APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Archer account\n2. Follow the [Archer API docs](https://docs.archermoney.com) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["ARCHER_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ARCHER_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-archer-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ARCHER_API_KEY: "$secrets.ARCHER_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
