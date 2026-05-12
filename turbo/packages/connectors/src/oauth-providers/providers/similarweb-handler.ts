import { type ProviderHandler } from "../provider-types";

export const similarwebHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("SimilarWeb does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("SimilarWeb does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SIMILARWEB_TOKEN";
  },
};
