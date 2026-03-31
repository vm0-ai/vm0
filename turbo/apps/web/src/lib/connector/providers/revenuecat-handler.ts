import { type ProviderHandler } from "../provider-types";

export const revenuecatHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("RevenueCat does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("RevenueCat does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "REVENUECAT_TOKEN";
  },
};
