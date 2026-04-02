import { type ProviderHandler } from "../provider-types";

export const supadataHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Supadata does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Supadata does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SUPADATA_TOKEN";
  },
};
