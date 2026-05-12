import { type ProviderHandler } from "../provider-types";

export const dropboxSignHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Dropbox Sign does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Dropbox Sign does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DROPBOX_SIGN_TOKEN";
  },
};
