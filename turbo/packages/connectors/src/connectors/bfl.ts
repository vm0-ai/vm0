import type { ConnectorConfig } from "../connectors";

export const bfl = {
  bfl: {
    label: "Black Forest Labs",
    category: "ai-image-video",
    generation: ["image"],
    helpText:
      "Connect your Black Forest Labs account to generate images with FLUX models",
    tags: ["flux"],
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Black Forest Labs dashboard](https://dashboard.bfl.ai)\n2. Navigate to **API → Keys** in your project sidebar\n3. Click **Add Key** and give the key a descriptive name\n4. Copy the API key immediately — you will not be able to see the full key again",
        grant: {
          kind: "manual",
          fields: {
            BFL_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "bfl_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            BFL_API_KEY: "$secrets.BFL_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
