import { type ProviderHandler } from "../provider-types";

export const cladoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Clado does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Clado does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CLADO_TOKEN";
  },
};
