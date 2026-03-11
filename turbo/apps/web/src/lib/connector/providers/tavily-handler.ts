import { type ProviderHandler } from "../provider-types";

export const tavilyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Tavily does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Tavily does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "TAVILY_TOKEN",
};
