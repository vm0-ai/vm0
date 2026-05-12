import { type ProviderHandler } from "../provider-types";

export const miroHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Miro does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Miro does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MIRO_TOKEN";
  },
};
