import { type ProviderHandler } from "../provider-types";

export const bufferHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Buffer does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Buffer does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BUFFER_TOKEN";
  },
};
