import type { ConnectorConfig } from "../connectors";

export const bland = {
  bland: {
    label: "Bland",
    category: "ai-voice-audio",
    generation: ["audio"],
    helpText:
      "Connect your Bland account to make AI phone calls and manage voice agents",
    tags: ["phone", "calls", "voice-agents"],
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Bland dashboard](https://app.bland.ai)\n2. Copy your API key from your account or API settings\n3. Paste the key here. You can also use the key with the Bland CLI as `BLAND_API_KEY`",
        storage: {
          secrets: ["BLAND_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BLAND_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "sk-...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BLAND_API_KEY: "$secrets.BLAND_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
