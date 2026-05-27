import type { ConnectorConfig } from "../connectors";

export const apify = {
  apify: {
    label: "Apify",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Apify account to run web scraping actors, manage datasets, and automate browser tasks",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Apify Console](https://console.apify.com)\n2. Go to **Settings > Integrations**\n3. Copy your **Personal API token**",
        grant: {
          kind: "manual",
          fields: {
            APIFY_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "apify_api_xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            APIFY_TOKEN: "$secrets.APIFY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
