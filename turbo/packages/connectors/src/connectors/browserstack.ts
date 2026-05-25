import type { ConnectorConfig } from "../connectors";

export const browserstack = {
  browserstack: {
    label: "BrowserStack",
    category: "engineering-team-execution",
    tags: ["testing", "selenium", "appium", "cross-browser", "qa", "automate"],
    helpText:
      "Connect your BrowserStack account to run Selenium / Appium tests, query builds and sessions, capture cross-browser screenshots, and upload mobile apps",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [BrowserStack](https://www.browserstack.com) and open **Account Settings**\n2. Copy your **Username** and **Access Key** from the **Authentication & Security** section\n3. Paste both values below — these credentials work across Live, Automate, App Live, and App Automate",
        grant: {
          kind: "manual",
          fields: {
            BROWSERSTACK_USERNAME: {
              label: "Username",
              required: true,
              placeholder: "your-bstack-username",
            },
            BROWSERSTACK_ACCESS_KEY: {
              label: "Access Key",
              required: true,
              placeholder: "your-bstack-access-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            BROWSERSTACK_USERNAME: "$secrets.BROWSERSTACK_USERNAME",
            BROWSERSTACK_ACCESS_KEY: "$secrets.BROWSERSTACK_ACCESS_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
