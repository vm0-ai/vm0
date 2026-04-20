import { type ProviderHandler } from "../provider-types";

export const productlaneHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Productlane does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Productlane does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PRODUCTLANE_TOKEN";
  },
};
