import type { ConnectorConfig } from "../connectors";

export const chert = {
  chert: {
    label: "Chert",
    category: "communication-collaboration",
    helpText:
      "Connect your Chert account to access iMessage infrastructure APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Chert account\n2. Follow the [Chert API docs](https://docs.trychert.com/introduction) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["CHERT_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CHERT_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-chert-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CHERT_API_KEY: "$secrets.CHERT_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
