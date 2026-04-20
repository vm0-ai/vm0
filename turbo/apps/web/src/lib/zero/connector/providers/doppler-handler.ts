import { type ProviderHandler } from "../provider-types";

export const dopplerHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Doppler does not support OAuth — use service token auth");
  },
  exchangeCode() {
    throw new Error("Doppler does not support OAuth — use service token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DOPPLER_TOKEN";
  },
};
