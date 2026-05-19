import { type ProviderHandler } from "../provider-types";

export const spongeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Sponge does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Sponge does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SPONGE_MASTER_KEY";
  },
};
