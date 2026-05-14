import { type ProviderHandler } from "../provider-types";

export const localBrowserHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Local Browser does not support OAuth");
  },
  exchangeCode() {
    throw new Error("Local Browser does not support OAuth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LOCAL_BROWSER";
  },
};
