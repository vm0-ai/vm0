import type { ConnectorConfig } from "../connectors";

export const discord = {
  discord: {
    label: "Discord",
    category: "communication-collaboration",
    environmentMapping: {
      DISCORD_BOT_TOKEN: "$secrets.DISCORD_BOT_TOKEN",
    },
    helpText:
      "Connect your Discord bot to manage servers, channels, messages, and automate interactions",
    authMethods: {
      "api-token": {
        label: "Bot Token",
        helpText:
          "1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)\n2. Select your application (or create a new one)\n3. Navigate to the **Bot** page in your app's settings\n4. In the **Token** section, click **Reset Token** to generate a new bot token\n5. Copy and securely store the token — you won't be able to view it again unless you regenerate it",
        secrets: {
          DISCORD_BOT_TOKEN: {
            label: "Bot Token",
            required: true,
            placeholder: "your-discord-bot-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
