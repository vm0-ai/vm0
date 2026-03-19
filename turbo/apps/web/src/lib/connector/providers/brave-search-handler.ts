import { type ProviderHandler } from "../provider-types";

export const braveSearchHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Brave Search does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Brave Search does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "BRAVE_API_KEY",
};
