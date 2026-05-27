import type { ConnectorConfig } from "../connectors";

export const gemini = {
  gemini: {
    label: "Gemini",
    category: "ai-general-models",
    generation: ["image", "text"],
    tags: ["llm", "ai", "google", "gemini", "multimodal"],
    helpText:
      "Connect your Google AI Studio account to access Gemini models for text generation, multimodal reasoning, embeddings, and function calling",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Google AI Studio](https://aistudio.google.com/apikey)\n2. Sign in with your Google account\n3. Click **Create API key**\n4. Copy the key (starts with `AIza`) and store it in a safe location",
        grant: {
          kind: "manual",
          fields: {
            GEMINI_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "AIza...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GEMINI_TOKEN: "$secrets.GEMINI_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
