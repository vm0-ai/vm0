import type { ConnectorConfig } from "../connectors";

export const plausible = {
  plausible: {
    label: "Plausible",
    environmentMapping: {
      PLAUSIBLE_TOKEN: "$secrets.PLAUSIBLE_TOKEN",
    },
    helpText:
      "Connect your Plausible Analytics account to access website traffic analytics, visitor stats, and site management",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Plausible Analytics](https://plausible.io)\n2. Go to **Account Settings** → **API Keys**\n3. Click **New API Key** and choose **Stats API**\n4. Copy the key (it is only shown once)",
        secrets: {
          PLAUSIBLE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-plausible-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
