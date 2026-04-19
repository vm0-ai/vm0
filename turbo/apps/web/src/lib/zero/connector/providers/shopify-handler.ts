import { type ProviderHandler } from "../provider-types";

export const shopifyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Shopify does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Shopify does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SHOPIFY_TOKEN";
  },
};
