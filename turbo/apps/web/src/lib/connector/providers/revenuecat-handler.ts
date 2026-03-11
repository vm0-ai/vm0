import { type ProviderHandler } from "../provider-types";

export const revenuecatHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("RevenueCat does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("RevenueCat does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "REVENUECAT_TOKEN",
};
