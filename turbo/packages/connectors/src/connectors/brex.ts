import type { ConnectorConfig } from "../connectors";

export const brex = {
  brex: {
    label: "Brex",
    category: "sales-crm-business-operations",
    tags: ["corporate-card", "expenses", "payments", "transactions", "finance"],
    helpText:
      "Connect your Brex account to access corporate card, expense, payment, transaction, and team data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. In Brex, create or obtain an API user token with the permissions required for your workflow\n2. Confirm the token is intended for the production API at `https://api.brex.com`\n3. Copy the token",
        grant: {
          kind: "manual",
          fields: {
            BREX_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-brex-api-token",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            BREX_TOKEN: "$secrets.BREX_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
