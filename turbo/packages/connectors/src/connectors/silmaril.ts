import type { ConnectorConfig } from "../connectors";

export const silmaril = {
  silmaril: {
    label: "Silmaril",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Silmaril account to access AI application firewall APIs and SDKs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Silmaril account\n2. Follow the [Silmaril API docs](https://www.silmaril.dev/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["SILMARIL_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SILMARIL_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-silmaril-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SILMARIL_API_KEY: "$secrets.SILMARIL_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
