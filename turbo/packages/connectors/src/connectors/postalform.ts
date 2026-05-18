import type { ConnectorConfig } from "../connectors";

export const postalform = {
  postalform: {
    label: "PostalForm",
    category: "communication-collaboration",
    environmentMapping: {
      POSTALFORM_TOKEN: "$secrets.POSTALFORM_TOKEN",
    },
    helpText:
      "Connect PostalForm to send direct mail, postcards, and physical letters from your app",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [PostalForm](https://postalform.com)\n2. Open **Settings → API Keys**\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://api.postalform.com`",
        secrets: {
          POSTALFORM_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
