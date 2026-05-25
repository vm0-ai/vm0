import type { ConnectorConfig } from "../connectors";

export const slackWebhook = {
  "slack-webhook": {
    label: "Slack Webhook",
    category: "communication-collaboration",
    helpText: "Connect a Slack incoming webhook to send messages to channels",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Create a [Slack app](https://api.slack.com/apps) (or use an existing one), choosing a workspace to associate it with\n2. From the app settings page, select **Incoming Webhooks**\n3. Toggle **Activate Incoming Webhooks** to on\n4. Click **Add New Webhook to Workspace**\n5. Pick a channel for the app to post to, then click **Authorize**\n6. Copy the webhook URL from the **Webhook URLs for Your Workspace** section (it will look like `https://hooks.slack.com/services/T.../B.../XXXX...`)",
        grant: {
          kind: "manual",
          fields: {
            SLACK_WEBHOOK_URL: {
              label: "Webhook URL",
              required: true,
              placeholder: "https://hooks.slack.com/services/xxx/xxx/xxx",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SLACK_WEBHOOK_URL: "$secrets.SLACK_WEBHOOK_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
