import type { ConnectorConfig } from "../connectors";

export const minimax = {
  minimax: {
    label: "MiniMax",
    category: "ai-general-models",
    generation: ["audio", "text", "video"],
    helpText:
      "Connect your MiniMax account to access AI model APIs for text, voice, and video generation",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [MiniMax Platform](https://platform.minimax.io)\n2. Go to **User Center > Basic Information > Interface Key**\n3. Create a new API key\n4. Copy the key",
        grant: {
          kind: "manual",
          fields: {
            MINIMAX_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-minimax-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            MINIMAX_TOKEN: "$secrets.MINIMAX_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
