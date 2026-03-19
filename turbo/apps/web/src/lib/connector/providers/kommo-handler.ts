import { type ProviderHandler } from "../provider-types";

export const kommoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Kommo does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Kommo does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "KOMMO_API_KEY",
};
