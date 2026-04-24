import type { ConnectorConfig } from "../connectors";

export const brevo = {
  brevo: {
    label: "Brevo",
    category: "communication-collaboration",
    environmentMapping: {
      BREVO_TOKEN: "$secrets.BREVO_TOKEN",
    },
    helpText:
      "Connect your Brevo account to manage email campaigns, transactional emails, and CRM contacts",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Brevo](https://app.brevo.com)\n2. Go to **Settings** → **SMTP & API** → **API Keys**\n3. Copy your API key",
        secrets: {
          BREVO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "xkeysib-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
