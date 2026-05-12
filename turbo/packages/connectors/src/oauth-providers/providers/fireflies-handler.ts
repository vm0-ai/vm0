import { type ProviderHandler } from "../provider-types";

export const firefliesHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Fireflies does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Fireflies does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "FIREFLIES_TOKEN";
  },
};
