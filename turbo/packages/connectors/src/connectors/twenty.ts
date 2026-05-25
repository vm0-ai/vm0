import type { ConnectorConfig } from "../connectors";

export const twenty = {
  twenty: {
    label: "Twenty",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Twenty CRM account to manage contacts, companies, and deals",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Twenty](https://twenty.com) workspace\n2. Go to **Settings > APIs & Webhooks**\n3. Click **+ Create key**\n4. Enter a descriptive **Name** and set an **Expiration Date**\n5. Click **Save**\n6. Copy the key immediately — it is only shown once",
        grant: {
          kind: "manual",
          fields: {
            TWENTY_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-twenty-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            TWENTY_TOKEN: "$secrets.TWENTY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
