import type { ConnectorConfig } from "../connectors";

export const suno = {
  suno: {
    label: "Suno",
    category: "ai-image-video",
    generation: ["audio"],
    environmentMapping: {
      SUNO_TOKEN: "$secrets.SUNO_TOKEN",
    },
    helpText:
      "Connect Suno to generate AI music tracks, vocals, and instrumentals from text prompts",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [SunoAPI](https://sunoapi.org)\n2. Open the **API Keys** page in your account\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://api.sunoapi.org`",
        secrets: {
          SUNO_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
