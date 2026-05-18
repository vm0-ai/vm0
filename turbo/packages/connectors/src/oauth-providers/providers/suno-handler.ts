import { type ProviderHandler } from "../provider-types";

export const sunoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Suno does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Suno does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SUNO_TOKEN";
  },
};
