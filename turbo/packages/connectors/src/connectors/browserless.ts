import type { ConnectorConfig } from "../connectors";

export const browserless = {
  browserless: {
    label: "Browserless",
    category: "data-automation-infrastructure",
    generation: ["document", "image"],
    helpText:
      "Connect your Browserless account to take screenshots, generate PDFs, scrape pages, and automate headless browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign up or log in at [Browserless](https://browserless.io/account/)\n2. Navigate to the account dashboard\n3. Copy your API token from the dashboard",
        storage: {
          secrets: ["BROWSERLESS_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BROWSERLESS_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BROWSERLESS_TOKEN: "$secrets.BROWSERLESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
