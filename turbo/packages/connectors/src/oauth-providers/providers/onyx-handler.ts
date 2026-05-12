import { type ProviderHandler } from "../provider-types";

export const onyxHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Onyx does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Onyx does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ONYX_TOKEN";
  },
};
