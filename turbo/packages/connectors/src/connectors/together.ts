import type { ConnectorConfig } from "../connectors";

export const together = {
  together: {
    label: "Together AI",
    category: "ai-general-models",
    generation: ["image", "text"],
    helpText:
      "Connect your Together AI account to run open-source models (Llama, Qwen, FLUX) via an OpenAI-compatible API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [api.together.ai](https://api.together.ai)\n2. Go to **Settings → API Keys**\n3. Click **Create API Key**\n4. Copy the key. Paste it here. Free $1 credit on signup.",
        grant: {
          kind: "manual",
          fields: {
            TOGETHER_TOKEN: {
              label: "API Key",
              required: true,
              placeholder:
                "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ff",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TOGETHER_TOKEN: "$secrets.TOGETHER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
