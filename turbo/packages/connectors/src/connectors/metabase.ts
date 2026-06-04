import type { ConnectorConfig } from "../connectors";

export const metabase = {
  metabase: {
    label: "Metabase",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Metabase instance to query data, manage dashboards, and automate analytics workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your Metabase instance as an admin\n2. Go to **Admin** → **Settings** → **Authentication** → **API Keys**\n3. Click **Create API Key**\n4. Enter a name and select a group for the key\n5. Copy the generated API key",
        storage: {
          secrets: ["METABASE_TOKEN"],
          variables: ["METABASE_BASE_URL"],
        },
        grant: {
          kind: "manual",
          fields: {
            METABASE_TOKEN: {
              label: "API Key",
              required: true,
            },
            METABASE_BASE_URL: {
              label: "Base URL",
              required: true,
              placeholder: "https://mycompany.metabaseapp.com",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            METABASE_TOKEN: "$secrets.METABASE_TOKEN",
            METABASE_BASE_URL: "$vars.METABASE_BASE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
