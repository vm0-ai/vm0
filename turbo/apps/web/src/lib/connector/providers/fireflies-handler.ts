import { type ProviderHandler } from "../provider-types";

export const firefliesHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Fireflies does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Fireflies does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "FIREFLIES_TOKEN",
};
