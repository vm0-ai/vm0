import type { ConnectorConfig } from "../connectors";

export const ardent = {
  ardent: {
    label: "Ardent",
    category: "data-automation-infrastructure",
    helpText: "Connect your Ardent account to access Postgres branching APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Ardent account\n2. Follow the [Ardent API docs](https://docs.tryardent.com/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["ARDENT_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ARDENT_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-ardent-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ARDENT_API_KEY: "$secrets.ARDENT_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
