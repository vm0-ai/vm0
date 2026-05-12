import { type ProviderHandler } from "../provider-types";

export const qdrantHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Qdrant does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Qdrant does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "QDRANT_TOKEN";
  },
};
