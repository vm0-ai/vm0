import { type ProviderHandler } from "../provider-types";

export const mapboxHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mapbox does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Mapbox does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MAPBOX_TOKEN";
  },
};
