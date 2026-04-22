import type { ConnectorConfig } from "../connectors";

export const zeptomail = {
  zeptomail: {
    label: "ZeptoMail",
    environmentMapping: {
      ZEPTOMAIL_TOKEN: "$secrets.ZEPTOMAIL_TOKEN",
    },
    helpText:
      "Connect your ZeptoMail account to send transactional emails via Zoho's email delivery service",
    authMethods: {
      "api-token": {
        label: "Send Mail Token",
        helpText:
          "1. Log in to [ZeptoMail](https://zeptomail.zoho.com)\n2. Select the Mail Agent for which you want to generate the API key\n3. Go to the **SMTP/API** tab\n4. In the **API** section, copy the **Agent alias** (agentkey)\n5. Submit a POST request to `https://api.zeptomail.com/v1.1/agents/{agentkey}/apikeys` with an `Authorization: Zoho-oauthtoken [your-token]` header\n6. The response will contain your send mail token (username and password)",
        secrets: {
          ZEPTOMAIL_TOKEN: {
            label: "Send Mail Token",
            required: true,
            placeholder: "your-zeptomail-send-mail-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
