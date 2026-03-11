import { type ProviderHandler } from "../provider-types";

export const heygenHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("HeyGen does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("HeyGen does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "HEYGEN_TOKEN",
};
