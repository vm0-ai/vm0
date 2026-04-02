import { type ProviderHandler } from "../provider-types";

export const difyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Dify does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Dify does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DIFY_TOKEN";
  },
};
