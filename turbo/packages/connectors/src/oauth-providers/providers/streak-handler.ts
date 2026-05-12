import { type ProviderHandler } from "../provider-types";

export const streakHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Streak does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Streak does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "STREAK_TOKEN";
  },
};
