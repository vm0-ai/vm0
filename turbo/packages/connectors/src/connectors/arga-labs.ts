import type { ConnectorConfig } from "../connectors";

export const argaLabs = {
  "arga-labs": {
    label: "Arga Labs",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Arga Labs account to access API twin and sandbox APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Arga Labs account\n2. Follow the [Arga Labs API docs](https://argalabs.com/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["ARGA_LABS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ARGA_LABS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-arga-labs-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ARGA_LABS_API_KEY: "$secrets.ARGA_LABS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
