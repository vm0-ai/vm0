import type { ConnectorConfig } from "../connectors";

export const insforge = {
  insforge: {
    label: "InsForge",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your InsForge account to access backend and cloud infrastructure APIs for agent-native apps",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your InsForge account\n2. Follow the [InsForge API docs](https://docs.insforge.dev/) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["INSFORGE_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            INSFORGE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-insforge-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INSFORGE_API_KEY: "$secrets.INSFORGE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
