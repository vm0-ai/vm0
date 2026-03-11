import { type ProviderHandler } from "../provider-types";

export const browserbaseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Browserbase does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Browserbase does not support OAuth — use API key auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "BROWSERBASE_TOKEN",
};
