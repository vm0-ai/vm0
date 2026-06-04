import type { ConnectorConfig } from "../connectors";

export const openrouter = {
  openrouter: {
    label: "OpenRouter",
    category: "ai-general-models",
    generation: ["text"],
    helpText:
      "Connect OpenRouter to call hundreds of LLMs through a single OpenAI-compatible API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [OpenRouter](https://openrouter.ai/keys)\n2. Click **Create Key**, name it, and set the credit limit you want\n3. Copy the key (format: `sk-or-v1-…`)\n4. Use it as a Bearer token on requests to `https://openrouter.ai/api/v1/...`",
        storage: {
          secrets: ["OPENROUTER_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            OPENROUTER_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk-or-v1-...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            OPENROUTER_TOKEN: "$secrets.OPENROUTER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
