import type { ConnectorConfig } from "../connectors";

export const customerIo = {
  "customer-io": {
    label: "Customer.io",
    category: "communication-collaboration",
    environmentMapping: {
      CUSTOMERIO_APP_TOKEN: "$secrets.CUSTOMERIO_APP_TOKEN",
    },
    helpText:
      "Connect your Customer.io account to send behavioral emails, SMS, and push notifications triggered by user events",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [Customer.io](https://fly.customer.io) account\n2. Go to **Account Settings > [API Credentials](https://fly.customer.io/settings/api_credentials)**\n3. Locate your **Site ID** and **API Key** on the Track API Keys page\n4. Copy both values (they are used together as basic authentication credentials in the format `site_id:api_key`, Base64-encoded)",
        secrets: {
          CUSTOMERIO_APP_TOKEN: {
            label: "App API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
