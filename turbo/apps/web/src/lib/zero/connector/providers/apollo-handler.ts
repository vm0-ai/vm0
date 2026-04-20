import { type ProviderHandler } from "../provider-types";

export const apolloHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Apollo does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Apollo does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "APOLLO_TOKEN";
  },
};
