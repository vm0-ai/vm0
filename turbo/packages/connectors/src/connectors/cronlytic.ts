import type { ConnectorConfig } from "../connectors";

export const cronlytic = {
  cronlytic: {
    label: "Cronlytic",
    category: "data-automation-infrastructure",
    environmentMapping: {
      CRONLYTIC_API_KEY: "$secrets.CRONLYTIC_API_KEY",
      CRONLYTIC_USER_ID: "$vars.CRONLYTIC_USER_ID",
    },
    helpText:
      "Connect your Cronlytic account to monitor cron jobs and scheduled tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Cronlytic dashboard](https://www.cronlytic.com/dashboard)\n2. Go to the **API Keys** section\n3. Click **Generate New API Key**\n4. Copy your **API Key** and **User ID** (both are required for authentication via `X-API-Key` and `X-User-ID` headers)",
        secrets: {
          CRONLYTIC_API_KEY: {
            label: "API Key",
            required: true,
          },
          CRONLYTIC_USER_ID: {
            label: "User ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
