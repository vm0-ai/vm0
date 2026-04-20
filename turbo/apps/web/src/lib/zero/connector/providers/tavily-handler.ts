import { type ProviderHandler } from "../provider-types";

export const tavilyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Tavily does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Tavily does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TAVILY_TOKEN";
  },
};
