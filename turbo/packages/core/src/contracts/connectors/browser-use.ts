import type { ConnectorConfig } from "../connectors";

export const browserUse = {
  "browser-use": {
    label: "Browser Use",
    environmentMapping: {
      BROWSER_USE_TOKEN: "$secrets.BROWSER_USE_TOKEN",
    },
    helpText:
      "Connect Browser Use to run AI-powered browser automation tasks — submit natural-language prompts and let agents complete web tasks in hosted browsers",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in at [cloud.browser-use.com](https://cloud.browser-use.com)\n2. Go to **Settings → API Keys**\n3. Click **Create new key**\n4. Copy the generated API key",
        secrets: {
          BROWSER_USE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "bu_CoffeeSafeLocalCoffeeSafeLocalCoffee",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
