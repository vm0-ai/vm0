import type { ConnectorConfig } from "../connectors";

export const hume = {
  hume: {
    label: "Hume",
    category: "ai-voice-audio",
    generation: ["audio"],
    helpText:
      "Connect your Hume account to access emotion AI, speech-to-speech, and expressive text-to-speech APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Hume Portal](https://app.hume.ai)\n2. Navigate to the **API Keys** page\n3. Copy your API key",
        grant: {
          kind: "manual",
          fields: {
            HUME_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            HUME_TOKEN: "$secrets.HUME_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
