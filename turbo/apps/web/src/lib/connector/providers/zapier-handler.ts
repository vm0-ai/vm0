import { type ProviderHandler } from "../provider-types";

export const zapierHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Zapier does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Zapier does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ZAPIER_TOKEN";
  },
};
