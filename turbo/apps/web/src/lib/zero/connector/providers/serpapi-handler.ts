import { type ProviderHandler } from "../provider-types";

export const serpapiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("SerpApi does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("SerpApi does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SERPAPI_TOKEN";
  },
};
