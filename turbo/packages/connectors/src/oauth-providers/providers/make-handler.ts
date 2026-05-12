import { type ProviderHandler } from "../provider-types";

export const makeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Make does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Make does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MAKE_TOKEN";
  },
};
