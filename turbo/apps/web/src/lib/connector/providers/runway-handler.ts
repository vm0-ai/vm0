import { type ProviderHandler } from "../provider-types";

export const runwayHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Runway does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Runway does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "RUNWAY_TOKEN",
};
