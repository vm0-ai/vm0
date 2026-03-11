import { type ProviderHandler } from "../provider-types";

export const browserlessHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Browserless does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Browserless does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "BROWSERLESS_TOKEN",
};
