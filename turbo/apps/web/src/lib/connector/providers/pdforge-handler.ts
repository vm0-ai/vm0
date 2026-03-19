import { type ProviderHandler } from "../provider-types";

export const pdforgeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PDForge does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("PDForge does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "PDFORGE_API_KEY",
};
