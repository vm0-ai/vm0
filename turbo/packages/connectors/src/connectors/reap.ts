import type { ConnectorConfig } from "../connectors";

export const reap = {
  reap: {
    label: "Reap",
    category: "sales-crm-business-operations",
    tags: [
      "fintech",
      "embedded-finance",
      "cards",
      "wallets",
      "payments",
      "compliance",
    ],
    helpText:
      "Connect your Reap project to manage users, companies, accounts, cards, virtual assets, activities, and reconciliations",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Contact the Reap team to obtain an API key for your project\n2. Choose the matching API base URL for the key environment: `https://sandbox.api.reap.global/v1` or `https://prod.api.reap.global/v1`\n3. Copy the API key",
        storage: {
          secrets: ["REAP_API_KEY"],
          variables: ["REAP_API_BASE_URL"],
        },
        grant: {
          kind: "manual",
          fields: {
            REAP_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "YOUR_REAP_API_KEY",
            },
            REAP_API_BASE_URL: {
              label: "API Base URL",
              required: true,
              placeholder: "https://sandbox.api.reap.global/v1",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            REAP_API_KEY: "$secrets.REAP_API_KEY",
            REAP_API_BASE_URL: "$vars.REAP_API_BASE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
