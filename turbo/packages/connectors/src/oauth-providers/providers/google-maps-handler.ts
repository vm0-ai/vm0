import { type ProviderHandler } from "../provider-types";

export const googleMapsHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Google Maps does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Google Maps does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GOOGLE_MAPS_TOKEN";
  },
};
