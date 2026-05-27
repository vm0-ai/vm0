import type { ConnectorConfig } from "../connectors";

export const bitrix = {
  bitrix: {
    label: "Bitrix24",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Bitrix24 account to manage CRM, tasks, and workflows",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Log in to your [Bitrix24](https://www.bitrix24.com) account\n2. Go to **Applications > Developer resources**\n3. Select the **Ready-made scenarios** tab\n4. Choose **Other > Incoming webhook**\n5. Configure the webhook name and set access permissions\n6. Click **Execute** to test the webhook\n7. Copy the generated webhook URL, which contains your secret code in the format `https://<domain>/rest/1/<secret-code>/<method>.json`",
        grant: {
          kind: "manual",
          fields: {
            BITRIX_WEBHOOK_URL: {
              label: "Webhook URL",
              required: true,
              placeholder: "https://your-domain.bitrix24.com/rest/1/xxx/",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BITRIX_WEBHOOK_URL: "$secrets.BITRIX_WEBHOOK_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
