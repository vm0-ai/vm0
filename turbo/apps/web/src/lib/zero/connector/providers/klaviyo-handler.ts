import { type ProviderHandler } from "../provider-types";

export const klaviyoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("klaviyo does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("klaviyo does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "KLAVIYO_TOKEN";
  },
};
