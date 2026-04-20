import { type ProviderHandler } from "../provider-types";

export const exploriumHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Explorium does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Explorium does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "EXPLORIUM_TOKEN";
  },
};
