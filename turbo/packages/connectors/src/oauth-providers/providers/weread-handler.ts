import { type ProviderHandler } from "../provider-types";

export const wereadHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("WeRead does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("WeRead does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "WEREAD_API_KEY";
  },
};
