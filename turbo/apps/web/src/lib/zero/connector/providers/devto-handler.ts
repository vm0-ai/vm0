import { type ProviderHandler } from "../provider-types";

export const devtoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Dev.to does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Dev.to does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DEVTO_TOKEN";
  },
};
