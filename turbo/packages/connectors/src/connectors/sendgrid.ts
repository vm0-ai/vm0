import type { ConnectorConfig } from "../connectors";

export const sendgrid = {
  sendgrid: {
    label: "SendGrid",
    category: "marketing-content-growth",
    tags: ["email", "transactional", "marketing", "twilio"],
    environmentMapping: {
      SENDGRID_TOKEN: "$secrets.SENDGRID_TOKEN",
    },
    helpText:
      "Connect your Twilio SendGrid account to send transactional and marketing email, manage templates, contacts, and suppressions",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [SendGrid](https://app.sendgrid.com) and open **Settings > API Keys**\n2. Click **Create API Key**, name it (e.g. `vm0`), and pick **Full Access** or a scoped permission set covering Mail Send, Templates, and Suppressions\n3. Click **Create & View** and copy the API key — it is shown only once\n4. Paste the key below (starts with `SG.`)",
        secrets: {
          SENDGRID_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "SG.xxxxxxxxxxxxxxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
