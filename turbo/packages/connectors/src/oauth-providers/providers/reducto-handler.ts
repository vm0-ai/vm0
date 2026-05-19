import { type ProviderHandler } from "../provider-types";

export const reductoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Reducto does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Reducto does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "REDUCTO_TOKEN";
  },
};
