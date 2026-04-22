import type { ConnectorConfig } from "../connectors";

export const devto = {
  devto: {
    label: "Dev.to",
    environmentMapping: {
      DEVTO_TOKEN: "$secrets.DEVTO_TOKEN",
    },
    helpText:
      "Connect your Dev.to account to publish articles, manage posts, and interact with the developer community",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [DEV.to](https://dev.to)\n2. Go to **Settings > Extensions** (or visit [dev.to/settings/extensions](https://dev.to/settings/extensions))\n3. Generate a new API key from the settings page\n4. Copy the API key and use it in the `api-key` request header",
        secrets: {
          DEVTO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-devto-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
