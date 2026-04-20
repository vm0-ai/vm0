import { type ProviderHandler } from "../provider-types";

export const braveSearchHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Brave Search does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Brave Search does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BRAVE_API_KEY";
  },
};
