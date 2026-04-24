import type { ConnectorConfig } from "../connectors";

export const streak = {
  streak: {
    label: "Streak",
    category: "sales-crm-business-operations",
    environmentMapping: {
      STREAK_TOKEN: "$secrets.STREAK_TOKEN",
    },
    helpText:
      "Connect your Streak account to manage CRM pipelines, contacts, and deals inside Gmail",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Install the Streak extension and navigate to [Gmail](https://mail.google.com)\n2. Click on the Streak icon in the right sidebar\n3. Select the **Integrations** button\n4. Under the **Streak API** section, click **Create New Key**\n5. Copy and store the API key securely",
        secrets: {
          STREAK_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-streak-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
