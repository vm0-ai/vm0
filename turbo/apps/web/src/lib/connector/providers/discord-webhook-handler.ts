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
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DISCORD_WEBHOOK_URL";
  },
};
