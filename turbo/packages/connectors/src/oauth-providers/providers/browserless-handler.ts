import { type ProviderHandler } from "../provider-types";

export const browserlessHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Browserless does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Browserless does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BROWSERLESS_TOKEN";
  },
};
