import { type ProviderHandler } from "../provider-types";

export const supadataHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Supadata does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Supadata does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "SUPADATA_TOKEN",
};
