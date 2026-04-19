import { type ProviderHandler } from "../provider-types";

export const codaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Coda does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Coda does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CODA_TOKEN";
  },
};
