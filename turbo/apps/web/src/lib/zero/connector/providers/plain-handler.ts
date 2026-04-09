import { type ProviderHandler } from "../provider-types";

export const plainHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Plain does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Plain does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "PLAIN_TOKEN",
};
