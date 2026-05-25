import type { ConnectorConfig } from "../connectors";

export const recraft = {
  recraft: {
    label: "Recraft",
    category: "ai-image-video",
    generation: ["image"],
    helpText:
      "Connect your Recraft account to generate, edit, and vectorize images with the Recraft API",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign in to [Recraft](https://app.recraft.ai)\n2. Open your profile\n3. Copy your API token\n4. Paste it here.",
        grant: {
          kind: "manual",
          fields: {
            RECRAFT_API_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            RECRAFT_API_TOKEN: "$secrets.RECRAFT_API_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
