import { type ProviderHandler } from "../provider-types";

export const reapHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Reap does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Reap does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "REAP_API_KEY";
  },
};
