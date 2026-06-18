import type { ConnectorConfig } from "../connectors";

export const minicor = {
  minicor: {
    label: "Minicor",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Minicor account to access computer-use and RPA automation APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Minicor account\n2. Follow the [Minicor API docs](https://www.minicor.com/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["MINICOR_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MINICOR_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-minicor-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MINICOR_API_KEY: "$secrets.MINICOR_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
