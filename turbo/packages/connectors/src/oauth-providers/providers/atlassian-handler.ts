import { type ProviderHandler } from "../provider-types";

export const atlassianHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Atlassian does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Atlassian does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ATLASSIAN_TOKEN";
  },
};
