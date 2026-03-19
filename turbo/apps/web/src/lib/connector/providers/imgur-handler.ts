import { type ProviderHandler } from "../provider-types";

export const imgurHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Imgur does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Imgur does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "IMGUR_CLIENT_ID",
};
