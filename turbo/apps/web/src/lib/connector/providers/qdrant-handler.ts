import { type ProviderHandler } from "../provider-types";

export const qdrantHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Qdrant does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Qdrant does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "QDRANT_TOKEN",
};
