import { type ProviderHandler } from "../provider-types";

export const discordHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Discord does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Discord does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "DISCORD_BOT_TOKEN",
};
