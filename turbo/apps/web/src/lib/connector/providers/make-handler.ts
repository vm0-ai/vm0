import { type ProviderHandler } from "../provider-types";

export const makeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Make does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Make does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "MAKE_TOKEN",
};
