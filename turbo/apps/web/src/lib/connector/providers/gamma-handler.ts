import { type ProviderHandler } from "../provider-types";

export const gammaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Gamma does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Gamma does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "GAMMA_TOKEN",
};
