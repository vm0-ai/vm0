import { type ProviderHandler } from "../provider-types";

export const shortioHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Short.io does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Short.io does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "SHORTIO_TOKEN",
};
