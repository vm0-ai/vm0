import { type ProviderHandler } from "../provider-types";

export const axiomHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Axiom does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Axiom does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "AXIOM_TOKEN",
};
