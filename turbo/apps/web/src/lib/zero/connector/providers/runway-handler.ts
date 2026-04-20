import { type ProviderHandler } from "../provider-types";

export const runwayHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Runway does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Runway does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "RUNWAY_TOKEN";
  },
};
