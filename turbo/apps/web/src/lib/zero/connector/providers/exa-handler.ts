import { type ProviderHandler } from "../provider-types";

export const exaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Exa does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Exa does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "EXA_TOKEN";
  },
};
