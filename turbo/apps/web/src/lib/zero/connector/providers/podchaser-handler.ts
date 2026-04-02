import { type ProviderHandler } from "../provider-types";

export const podchaserHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Podchaser does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Podchaser does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PODCHASER_TOKEN";
  },
};
