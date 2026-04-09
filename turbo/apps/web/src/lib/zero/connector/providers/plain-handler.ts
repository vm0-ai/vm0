import { type ProviderHandler } from "../provider-types";

export const plainHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Plain does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Plain does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PLAIN_TOKEN";
  },
};
