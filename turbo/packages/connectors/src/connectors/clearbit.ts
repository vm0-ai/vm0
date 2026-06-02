import type { ConnectorConfig } from "../connectors";

export const clearbit = {
  clearbit: {
    label: "Clearbit",
    category: "sales-crm-business-operations",
    helpText:
      "Connect Clearbit to enrich people and companies using an existing Clearbit API key",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Clearbit](https://dashboard.clearbit.com)\n2. Go to **Settings > Keys & Settings**\n3. Reveal and copy your **Secret API Key**\n\nClearbit API keys are available only for accounts created in 2023 or earlier; new 2024+ accounts may require HubSpot/Breeze Intelligence access instead.",
        storage: {
          secrets: ["CLEARBIT_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CLEARBIT_TOKEN: {
              label: "Secret API Key",
              required: true,
              placeholder: "sk_your_secret_api_key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CLEARBIT_TOKEN: "$secrets.CLEARBIT_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
