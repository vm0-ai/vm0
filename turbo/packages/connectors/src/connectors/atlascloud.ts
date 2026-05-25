import type { ConnectorConfig } from "../connectors";

export const atlascloud = {
  atlascloud: {
    label: "Atlas Cloud",
    category: "ai-general-models",
    generation: ["audio", "image", "text", "video"],
    tags: ["llm", "multimodal", "openai-compatible"],
    helpText:
      "Connect Atlas Cloud to access multimodal AI models for chat, image generation, video generation, and audio through one API key",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Atlas Cloud](https://console.atlascloud.ai)\n2. Go to **API Keys**\n3. Click **Create API Key**\n4. Copy the key and use it with `https://api.atlascloud.ai/v1` for OpenAI-compatible chat or `https://api.atlascloud.ai/api/v1` for image, video, and media APIs",
        grant: {
          kind: "manual",
          fields: {
            ATLASCLOUD_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-atlascloud-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            ATLASCLOUD_API_KEY: "$secrets.ATLASCLOUD_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
