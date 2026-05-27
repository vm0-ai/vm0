import type { ConnectorConfig } from "../connectors";

export const adzuna = {
  adzuna: {
    label: "Adzuna",
    category: "data-automation-infrastructure",
    tags: ["jobs", "employment", "salary", "vacancies"],
    helpText:
      "Connect Adzuna to search job ads and retrieve employment, salary, vacancy, category, and API version data",
    authMethods: {
      "api-token": {
        label: "App ID and App Key",
        helpText:
          "1. Register at the [Adzuna Developer Portal](https://developer.adzuna.com)\n2. Copy your **app_id** and **app_key**\n3. Pass them as the `app_id` and `app_key` query parameters on Adzuna API requests",
        grant: {
          kind: "manual",
          fields: {
            ADZUNA_APP_ID: {
              label: "App ID",
              required: true,
              storage: "variable",
              placeholder: "your-adzuna-app-id",
            },
            ADZUNA_APP_KEY: {
              label: "App Key",
              required: true,
              placeholder: "your-adzuna-app-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ADZUNA_APP_ID: "$vars.ADZUNA_APP_ID",
            ADZUNA_APP_KEY: "$secrets.ADZUNA_APP_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
