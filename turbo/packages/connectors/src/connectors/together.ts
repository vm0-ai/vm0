import type { ConnectorConfig } from "../connectors";

export const together = {
  together: {
    label: "Together AI",
    category: "ai-general-models",
    environmentMapping: {
      TOGETHER_TOKEN: "$secrets.TOGETHER_TOKEN",
    },
    helpText:
      "Connect your Together AI account to run open-source models (Llama, Qwen, FLUX) via an OpenAI-compatible API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [api.together.ai](https://api.together.ai)\n2. Go to **Settings → API Keys**\n3. Click **Create API Key**\n4. Copy the key. Paste it here. Free $1 credit on signup.",
        secrets: {
          TOGETHER_TOKEN: {
            label: "API Key",
            required: true,
            placeholder:
              "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ff",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
