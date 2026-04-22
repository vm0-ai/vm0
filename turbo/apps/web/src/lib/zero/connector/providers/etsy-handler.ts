import { type ProviderHandler } from "../provider-types";

export const etsyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Etsy does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Etsy does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ETSY_TOKEN";
  },
};
