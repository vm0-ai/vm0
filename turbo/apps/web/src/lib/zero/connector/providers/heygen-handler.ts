import { type ProviderHandler } from "../provider-types";

export const heygenHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("HeyGen does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("HeyGen does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "HEYGEN_TOKEN";
  },
};
