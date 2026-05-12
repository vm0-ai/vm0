import { type ProviderHandler } from "../provider-types";

export const strapiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Strapi does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Strapi does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "STRAPI_TOKEN";
  },
};
