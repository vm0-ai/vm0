import { type ProviderHandler } from "../provider-types";

export const instantlyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Instantly does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Instantly does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "INSTANTLY_API_KEY";
  },
};
