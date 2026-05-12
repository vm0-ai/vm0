import { type ProviderHandler } from "../provider-types";

export const amplitudeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Amplitude does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Amplitude does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "AMPLITUDE_API_KEY";
  },
};
