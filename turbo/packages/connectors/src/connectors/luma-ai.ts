import type { ConnectorConfig } from "../connectors";

export const lumaAi = {
  "luma-ai": {
    label: "Luma AI",
    category: "ai-image-video",
    generation: ["image", "video"],
    helpText:
      "Connect your Luma AI account to generate videos and images using the Dream Machine API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [lumalabs.ai](https://lumalabs.ai)\n2. Go to [lumalabs.ai/dream-machine/api](https://lumalabs.ai/dream-machine/api) or account settings → API Keys\n3. Create a new API key and copy it\n4. Paste the key here",
        grant: {
          kind: "manual",
          fields: {
            LUMA_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-luma-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            LUMA_TOKEN: "$secrets.LUMA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
