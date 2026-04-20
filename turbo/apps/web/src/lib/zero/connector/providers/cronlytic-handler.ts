import { type ProviderHandler } from "../provider-types";

export const cronlyticHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cronlytic does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cronlytic does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CRONLYTIC_API_KEY";
  },
};
