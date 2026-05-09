import type { ConnectorConfig } from "../connectors";

export const openai = {
  openai: {
    label: "OpenAI",
    category: "ai-general-models",
    generation: ["audio", "image", "text"],
    tags: ["llm", "ai", "gpt", "chatgpt"],
    environmentMapping: {
      OPENAI_TOKEN: "$secrets.OPENAI_TOKEN",
    },
    helpText:
      "Connect your OpenAI account to access GPT models, embeddings, image generation, and other AI capabilities",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [OpenAI Platform](https://platform.openai.com)\n2. Navigate to the [API Keys](https://platform.openai.com/api-keys) page in the dashboard\n3. Create a new API key\n4. Copy and store the key in a safe location",
        secrets: {
          OPENAI_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
