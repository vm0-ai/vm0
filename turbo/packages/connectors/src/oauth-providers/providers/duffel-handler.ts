import { type ProviderHandler } from "../provider-types";

export const duffelHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Duffel does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Duffel does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DUFFEL_TOKEN";
  },
};
