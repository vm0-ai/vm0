import { type ProviderHandler } from "../provider-types";

export const instantlyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Instantly does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Instantly does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "INSTANTLY_API_KEY",
};
