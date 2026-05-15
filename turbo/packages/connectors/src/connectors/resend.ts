import type { ConnectorConfig } from "../connectors";

export const resend = {
  resend: {
    label: "Resend",
    category: "communication-collaboration",
    environmentMapping: {
      RESEND_TOKEN: "$secrets.RESEND_TOKEN",
    },
    helpText:
      "Connect your Resend account to send transactional emails, manage domains, audiences, and contacts",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Resend](https://resend.com)\n2. Navigate to the [API Keys](https://resend.com/api-keys) page\n3. Click **Create API Key**\n4. Enter a name for your key (up to 50 characters)\n5. Select the permission level: **Full access** or **Sending access**\n6. If choosing sending access, select which domain the key can access\n7. Copy the generated API key",
        secrets: {
          RESEND_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "re_xxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
