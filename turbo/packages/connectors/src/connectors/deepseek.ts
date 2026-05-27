import type { ConnectorConfig } from "../connectors";

export const deepseek = {
  deepseek: {
    label: "DeepSeek",
    category: "ai-general-models",
    generation: ["code", "text"],
    helpText:
      "Connect your DeepSeek account to use DeepSeek AI models for chat completions, code generation, and reasoning tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [DeepSeek Platform](https://platform.deepseek.com/api_keys)\n2. Sign up for an account or log in\n3. Navigate to the **API Keys** page\n4. Create a new API key and copy it",
        grant: {
          kind: "manual",
          fields: {
            DEEPSEEK_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk-...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DEEPSEEK_TOKEN: "$secrets.DEEPSEEK_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
