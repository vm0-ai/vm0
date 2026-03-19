import { type ProviderHandler } from "../provider-types";

export const discordWebhookHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Discord Webhook does not support OAuth — use API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Discord Webhook does not support OAuth — use API token auth",
    );
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "DISCORD_WEBHOOK_URL",
};
