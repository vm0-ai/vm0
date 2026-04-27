import type { ConnectorConfig } from "../connectors";

export const twenty = {
  twenty: {
    label: "Twenty",
    category: "sales-crm-business-operations",
    environmentMapping: {
      TWENTY_TOKEN: "$secrets.TWENTY_TOKEN",
    },
    helpText:
      "Connect your Twenty CRM account to manage contacts, companies, and deals",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Twenty](https://twenty.com) workspace\n2. Go to **Settings > APIs & Webhooks**\n3. Click **+ Create key**\n4. Enter a descriptive **Name** and set an **Expiration Date**\n5. Click **Save**\n6. Copy the key immediately — it is only shown once",
        secrets: {
          TWENTY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-twenty-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
