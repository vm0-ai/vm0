import { type ProviderHandler } from "../provider-types";

export const browserUseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Browser Use does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Browser Use does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BROWSER_USE_TOKEN";
  },
};
