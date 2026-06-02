import type { ConnectorConfig } from "../connectors";

export const groq = {
  groq: {
    label: "Groq",
    category: "ai-general-models",
    generation: ["text"],
    tags: ["llm", "ai", "llama", "inference"],
    helpText:
      "Connect your Groq account to run ultra-fast LLM inference on open-weight models (Llama, Mixtral, Gemma) and Whisper audio transcription using Groq's LPU hardware",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [console.groq.com](https://console.groq.com)\n2. Click **API Keys** in the left sidebar\n3. Click **Create API Key**, name it, and copy it immediately — it is shown only once\n4. Paste it here. Free tier available; the key is org-bound.",
        storage: {
          secrets: ["GROQ_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            GROQ_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "gsk_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GROQ_TOKEN: "$secrets.GROQ_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
