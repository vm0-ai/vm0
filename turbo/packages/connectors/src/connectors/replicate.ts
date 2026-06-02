import type { ConnectorConfig } from "../connectors";

export const replicate = {
  replicate: {
    label: "Replicate",
    category: "ai-image-video",
    generation: ["image", "text"],
    helpText:
      "Connect your Replicate account to run open-source ML models for image generation, text generation, and more",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign up at [replicate.com](https://replicate.com)\n2. Click your avatar → **API Tokens**\n3. Click **Create token**, give it a name\n4. Copy the token (starts with `r8_`)\n5. Paste it here",
        storage: {
          secrets: ["REPLICATE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            REPLICATE_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "r8_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            REPLICATE_TOKEN: "$secrets.REPLICATE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
