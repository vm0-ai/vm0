import { type ProviderHandler } from "../provider-types";

export const discordHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Discord does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Discord does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DISCORD_BOT_TOKEN";
  },
};
