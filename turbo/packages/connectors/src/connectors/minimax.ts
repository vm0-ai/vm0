import type { ConnectorConfig } from "../connectors";

export const minimax = {
  minimax: {
    label: "MiniMax",
    category: "ai-general-models",
    environmentMapping: {
      MINIMAX_TOKEN: "$secrets.MINIMAX_TOKEN",
    },
    helpText:
      "Connect your MiniMax account to access AI model APIs for text, voice, and video generation",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [MiniMax Platform](https://platform.minimax.io)\n2. Go to **User Center > Basic Information > Interface Key**\n3. Create a new API key\n4. Copy the key",
        secrets: {
          MINIMAX_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-minimax-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
