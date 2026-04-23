import { type ProviderHandler } from "../provider-types";

export const lovartHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Lovart does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Lovart does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LOVART_ACCESS_KEY";
  },
};
