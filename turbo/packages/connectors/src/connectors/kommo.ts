import type { ConnectorConfig } from "../connectors";

export const kommo = {
  kommo: {
    label: "Kommo",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Kommo account to manage leads, contacts, and sales pipelines",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Kommo](https://www.kommo.com) and create a **private integration**\n2. Go to the **Keys and Scopes** tab in your private integration settings\n3. Click **Generate long-lived token**\n4. Set the token expiration date (from 1 day to 5 years)\n5. Copy and save the token immediately (it will only be displayed once)",
        grant: {
          kind: "manual",
          fields: {
            KOMMO_API_KEY: {
              label: "API Key",
              required: true,
            },
            KOMMO_SUBDOMAIN: {
              label: "Subdomain",
              required: true,
              storage: "variable",
              placeholder: "your-subdomain",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            KOMMO_API_KEY: "$secrets.KOMMO_API_KEY",
            KOMMO_SUBDOMAIN: "$vars.KOMMO_SUBDOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
