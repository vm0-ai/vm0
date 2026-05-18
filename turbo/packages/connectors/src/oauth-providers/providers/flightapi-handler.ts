import { type ProviderHandler } from "../provider-types";

export const flightapiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("FlightAPI does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("FlightAPI does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "FLIGHTAPI_TOKEN";
  },
};
