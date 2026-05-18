import { type ProviderHandler } from "../provider-types";

export const builtwithHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("BuiltWith does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("BuiltWith does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BUILTWITH_TOKEN";
  },
};
