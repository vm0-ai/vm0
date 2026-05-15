import { type ProviderHandler } from "../provider-types";

export const bentomlHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("BentoML does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("BentoML does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BENTO_CLOUD_API_KEY";
  },
};
