import { type ProviderHandler } from "../provider-types";

export const perplexityHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Perplexity does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Perplexity does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PERPLEXITY_TOKEN";
  },
};
