import { type ProviderHandler } from "../provider-types";

export const scrapeninjaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ScrapeNinja does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("ScrapeNinja does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SCRAPENINJA_TOKEN";
  },
};
