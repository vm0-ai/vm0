import { type ProviderHandler } from "../provider-types";

export const firecrawlHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Firecrawl does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Firecrawl does not support OAuth — use API key auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "FIRECRAWL_TOKEN",
};
