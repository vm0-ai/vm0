import { type ProviderHandler } from "../provider-types";

export const jamHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Jam does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Jam does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "JAM_TOKEN";
  },
};
