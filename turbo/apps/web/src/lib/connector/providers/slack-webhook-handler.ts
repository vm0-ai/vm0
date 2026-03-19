import { type ProviderHandler } from "../provider-types";

export const slackWebhookHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Slack Webhook does not support OAuth — use webhook URL auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Slack Webhook does not support OAuth — use webhook URL auth",
    );
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "SLACK_WEBHOOK_URL",
};
