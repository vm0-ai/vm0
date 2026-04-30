import type { ConnectorConfig } from "../connectors";

export const elevenlabs = {
  elevenlabs: {
    label: "ElevenLabs",
    category: "ai-voice-audio",
    generation: ["audio"],
    environmentMapping: {
      ELEVENLABS_TOKEN: "$secrets.ELEVENLABS_TOKEN",
    },
    helpText:
      "Connect your ElevenLabs account to generate speech, clone voices, manage audio projects, and access sound effects",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [ElevenLabs](https://elevenlabs.io)\n2. Go to [Settings > API Keys](https://elevenlabs.io/app/settings/api-keys)\n3. Click to create a new API key\n4. Copy the key and store it securely",
        secrets: {
          ELEVENLABS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-elevenlabs-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
