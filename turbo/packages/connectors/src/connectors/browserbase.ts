import type { ConnectorConfig } from "../connectors";

export const browserbase = {
  browserbase: {
    label: "Browserbase",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Browserbase account to create browser sessions, persist contexts, and automate cloud browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign up for a [Browserbase](https://www.browserbase.com/sign-up) account\n2. Log in and navigate to the **Overview** dashboard\n3. Your **Project ID** and **API key** are displayed on the right side of the Overview page\n4. Copy the API key",
        grant: {
          kind: "manual",
          fields: {
            BROWSERBASE_TOKEN: {
              label: "API Token",
              required: true,
            },
            BROWSERBASE_PROJECT_ID: {
              label: "Project ID",
              required: true,
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BROWSERBASE_TOKEN: "$secrets.BROWSERBASE_TOKEN",
            BROWSERBASE_PROJECT_ID: "$vars.BROWSERBASE_PROJECT_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
