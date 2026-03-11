import { type ProviderHandler } from "../provider-types";

export const twentyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Twenty does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Twenty does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "TWENTY_TOKEN",
};
