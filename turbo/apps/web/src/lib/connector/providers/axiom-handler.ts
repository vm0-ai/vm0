import { type ProviderHandler } from "../provider-types";

export const axiomHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Axiom does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Axiom does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "AXIOM_TOKEN";
  },
};
