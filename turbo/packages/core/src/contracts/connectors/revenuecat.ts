import type { ConnectorConfig } from "../connectors";

export const revenuecat = {
  revenuecat: {
    label: "RevenueCat",
    environmentMapping: {
      REVENUECAT_TOKEN: "$secrets.REVENUECAT_TOKEN",
    },
    helpText:
      "Connect your RevenueCat account to manage in-app subscriptions, purchases, and customer data",
    authMethods: {
      "api-token": {
        label: "Secret API Key",
        helpText:
          "1. Log in to [RevenueCat](https://app.revenuecat.com)\n2. Navigate to the **API keys** section in your project dashboard\n3. Public API keys are automatically created when you add an app to your project\n4. To create a secret API key, click **+ New secret API key** in the API keys section\n5. Copy and store the key securely (never embed secret keys in client-side code)",
        secrets: {
          REVENUECAT_TOKEN: {
            label: "Secret API Key",
            required: true,
            placeholder: "sk_xxxxxxxxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
