import { type ProviderHandler } from "../provider-types";

export const apifyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Apify does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Apify does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "APIFY_TOKEN";
  },
};
