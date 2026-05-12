import { type ProviderHandler } from "../provider-types";

export const stabilityAiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Stability AI does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Stability AI does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "STABILITY_TOKEN";
  },
};
