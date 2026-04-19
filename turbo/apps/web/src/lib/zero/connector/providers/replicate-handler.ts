import { type ProviderHandler } from "../provider-types";

export const replicateHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Replicate does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Replicate does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "REPLICATE_TOKEN";
  },
};
