import { type ProviderHandler } from "../provider-types";

export const instagramHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Instagram does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Instagram does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "INSTAGRAM_TOKEN";
  },
};
