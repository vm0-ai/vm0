import { type ProviderHandler } from "../provider-types";

export const zepHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Zep does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Zep does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ZEP_TOKEN";
  },
};
