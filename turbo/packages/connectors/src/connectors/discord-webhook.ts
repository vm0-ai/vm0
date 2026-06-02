import type { ConnectorConfig } from "../connectors";

export const discordWebhook = {
  "discord-webhook": {
    label: "Discord Webhook",
    category: "communication-collaboration",
    helpText: "Connect a Discord webhook to send messages to channels",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Open your Discord server and navigate to **Server Settings**\n2. Select the **Integrations** tab\n3. Click the **Create Webhook** button\n4. Configure the webhook name and select the target text channel from the dropdown menu\n5. Click the **Copy Webhook URL** button to copy the webhook URL",
        storage: {
          secrets: ["DISCORD_WEBHOOK_URL"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            DISCORD_WEBHOOK_URL: {
              label: "Webhook URL",
              required: true,
              placeholder: "https://discord.com/api/webhooks/xxx/xxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DISCORD_WEBHOOK_URL: "$secrets.DISCORD_WEBHOOK_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
