import type { ConnectorConfig } from "../connectors";

export const stabilityAi = {
  "stability-ai": {
    label: "Stability AI",
    category: "ai-image-video",
    generation: ["image"],
    helpText:
      "Connect your Stability AI account to generate images using Stable Diffusion models",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [platform.stability.ai](https://platform.stability.ai)\n2. Go to **Account → API Keys → Create API Key**\n3. Copy the key (starts with `sk-`). Paste here. Free credits on signup.",
        grant: {
          kind: "manual",
          fields: {
            STABILITY_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk-...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            STABILITY_TOKEN: "$secrets.STABILITY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
