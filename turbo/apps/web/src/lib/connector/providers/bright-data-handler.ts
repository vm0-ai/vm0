import { type ProviderHandler } from "../provider-types";

export const brightDataHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Bright Data does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Bright Data does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BRIGHTDATA_TOKEN";
  },
};
