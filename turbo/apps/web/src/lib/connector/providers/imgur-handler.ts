import { type ProviderHandler } from "../provider-types";

export const imgurHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Imgur does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Imgur does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "IMGUR_CLIENT_ID";
  },
};
