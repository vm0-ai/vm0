import { type ProviderHandler } from "../provider-types";

export const lumaAiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Luma AI does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Luma AI does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LUMA_TOKEN";
  },
};
