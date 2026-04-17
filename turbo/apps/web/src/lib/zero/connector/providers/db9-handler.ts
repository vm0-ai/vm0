import { type ProviderHandler } from "../provider-types";

export const db9Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("db9 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("db9 does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DB9_API_KEY";
  },
};
