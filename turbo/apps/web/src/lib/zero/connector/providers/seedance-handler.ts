import { type ProviderHandler } from "../provider-types";

export const seedanceHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Seedance does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Seedance does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SEEDANCE_TOKEN";
  },
};
