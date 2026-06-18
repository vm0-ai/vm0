import type { ConnectorConfig } from "../connectors";

export const inth = {
  inth: {
    label: "Inth",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Inth account to access privacy-compliance infrastructure APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Inth account\n2. Follow the [Inth API docs](https://inth.com/docs/getting-started) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["INTH_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            INTH_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-inth-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INTH_API_KEY: "$secrets.INTH_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
