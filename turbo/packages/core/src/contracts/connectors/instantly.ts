import type { ConnectorConfig } from "../connectors";

export const instantly = {
  instantly: {
    label: "Instantly",
    environmentMapping: {
      INSTANTLY_API_KEY: "$secrets.INSTANTLY_API_KEY",
    },
    helpText:
      "Connect your Instantly account to manage email campaigns, leads, and outreach sequences",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Instantly](https://app.instantly.ai)\n2. Navigate to **Settings > Integrations** at https://app.instantly.ai/app/settings/integrations\n3. Click the **API Keys** section in the left sidebar\n4. Click the **Create API Key** button\n5. Enter a name for the API key\n6. Select the scopes (permissions) you want the API key to have\n7. Click **Create**\n8. Copy the key and store it in a secure place (it will only be displayed once)",
        secrets: {
          INSTANTLY_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-instantly-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
