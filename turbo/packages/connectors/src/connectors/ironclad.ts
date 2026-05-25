import type { ConnectorConfig } from "../connectors";

export const ironclad = {
  ironclad: {
    label: "Ironclad",
    category: "sales-crm-business-operations",
    tags: ["contracts", "clm", "workflows", "legal"],
    helpText:
      "Connect your Ironclad account to manage contract workflows, records, and documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Ironclad, go to **Company Settings → API**\n2. Generate an API key and copy it\n3. Set the API host to match your instance's data region: `ironcladapp.com` (North America), `eu1.ironcladapp.com` (Europe), or `demo.ironcladapp.com` (demo)",
        grant: {
          kind: "manual",
          fields: {
            IRONCLAD_API_KEY: {
              label: "API Key",
              required: true,
            },
            IRONCLAD_HOST: {
              label: "API Host",
              required: true,
              storage: "variable",
              placeholder: "ironcladapp.com",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            IRONCLAD_API_KEY: "$secrets.IRONCLAD_API_KEY",
            IRONCLAD_HOST: "$vars.IRONCLAD_HOST",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
