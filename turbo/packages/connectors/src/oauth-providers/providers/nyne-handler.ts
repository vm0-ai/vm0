import { type ProviderHandler } from "../provider-types";

export const nyneHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Nyne does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Nyne does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "NYNE_API_KEY";
  },
};
