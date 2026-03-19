import { type ProviderHandler } from "../provider-types";

export const wixHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Wix does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Wix does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "WIX_TOKEN",
};
