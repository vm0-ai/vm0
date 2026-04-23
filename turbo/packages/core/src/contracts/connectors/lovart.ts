import type { ConnectorConfig } from "../connectors";

export const lovart = {
  lovart: {
    label: "Lovart",
    environmentMapping: {
      LOVART_ACCESS_KEY: "$secrets.LOVART_ACCESS_KEY",
      LOVART_SECRET_KEY: "$secrets.LOVART_SECRET_KEY",
    },
    helpText:
      "Connect your Lovart account to generate AI-powered designs, images, and videos",
    authMethods: {
      "api-token": {
        label: "Access Credentials",
        helpText:
          "1. Log in to Lovart at lovart.ai\n2. Go to **Settings** → **API Keys**\n3. Click **Create API Key** to generate an Access Key and Secret Key pair\n4. Copy both keys — the Secret Key cannot be retrieved after creation\n5. Paste the Access Key and Secret Key below",
        secrets: {
          LOVART_ACCESS_KEY: {
            label: "Access Key",
            required: true,
            type: "secret",
            placeholder: "ak_...",
          },
          LOVART_SECRET_KEY: {
            label: "Secret Key",
            required: true,
            type: "secret",
            placeholder: "sk_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
