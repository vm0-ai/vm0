import { type ProviderHandler } from "../provider-types";

export const cronlyticHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cronlytic does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cronlytic does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "CRONLYTIC_API_KEY",
};
