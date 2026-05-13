import { type ProviderHandler } from "../provider-types";

export const browserstackHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("BrowserStack does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("BrowserStack does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BROWSERSTACK_USERNAME";
  },
};
