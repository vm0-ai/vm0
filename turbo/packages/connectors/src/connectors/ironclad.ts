import type { ConnectorConfig } from "../connectors";

export const ironclad = {
  ironclad: {
    label: "Ironclad",
    category: "sales-crm-business-operations",
    tags: ["contracts", "clm", "workflows", "legal"],
    environmentMapping: {
      IRONCLAD_API_KEY: "$secrets.IRONCLAD_API_KEY",
      IRONCLAD_HOST: "$vars.IRONCLAD_HOST",
    },
    helpText:
      "Connect your Ironclad account to manage contract workflows, records, and documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Ironclad, go to **Company Settings → API**\n2. Generate an API key and copy it\n3. Set the API host to match your instance's data region: `ironcladapp.com` (North America), `eu1.ironcladapp.com` (Europe), or `demo.ironcladapp.com` (demo)",
        secrets: {
          IRONCLAD_API_KEY: {
            label: "API Key",
            required: true,
          },
          IRONCLAD_HOST: {
            label: "API Host",
            required: true,
            type: "variable",
            placeholder: "ironcladapp.com",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
