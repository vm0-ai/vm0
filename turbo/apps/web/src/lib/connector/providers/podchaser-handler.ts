import { type ProviderHandler } from "../provider-types";

export const podchaserHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Podchaser does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Podchaser does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "PODCHASER_TOKEN",
};
