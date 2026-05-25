import type { ConnectorConfig } from "../connectors";

export const meshy = {
  meshy: {
    label: "Meshy",
    category: "ai-image-video",
    generation: ["image"],
    helpText:
      "Connect your Meshy account to generate 3D assets and images with the Meshy API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Meshy](https://www.meshy.ai)\n2. Open the [API settings page](https://www.meshy.ai/settings/api)\n3. Click **Create API Key**\n4. Copy the API key. You will not be able to see it again.",
        grant: {
          kind: "manual",
          fields: {
            MESHY_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "msy_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            MESHY_API_KEY: "$secrets.MESHY_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
