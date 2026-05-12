import { type ProviderHandler } from "../provider-types";

export const pushinatorHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Pushinator does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Pushinator does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PUSHINATOR_TOKEN";
  },
};
