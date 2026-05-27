import type { ConnectorConfig } from "../connectors";

export const pipedrive = {
  pipedrive: {
    label: "Pipedrive",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Pipedrive account to manage your sales pipeline — deals, contacts, organizations, activities, and notes",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Pipedrive, click your avatar (top right) → **Personal Preferences** → **API**\n2. Copy your personal API token\n3. Paste it here",
        grant: {
          kind: "manual",
          fields: {
            PIPEDRIVE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-pipedrive-api-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PIPEDRIVE_TOKEN: "$secrets.PIPEDRIVE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
