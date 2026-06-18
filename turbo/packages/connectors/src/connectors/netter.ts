import type { ConnectorConfig } from "../connectors";

export const netter = {
  netter: {
    label: "Netter",
    category: "data-automation-infrastructure",
    helpText: "Connect your Netter account to access AI data platform APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Netter account\n2. Follow the [Netter API docs](https://netter.ai/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["NETTER_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            NETTER_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-netter-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            NETTER_API_KEY: "$secrets.NETTER_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
