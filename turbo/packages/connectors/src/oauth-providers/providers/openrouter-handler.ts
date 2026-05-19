import { type ProviderHandler } from "../provider-types";

export const openrouterHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("OpenRouter does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("OpenRouter does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "OPENROUTER_TOKEN";
  },
};
