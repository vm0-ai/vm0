import { type ProviderHandler } from "../provider-types";

export const productlaneHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Productlane does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Productlane does not support OAuth — use API key auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "PRODUCTLANE_TOKEN",
};
