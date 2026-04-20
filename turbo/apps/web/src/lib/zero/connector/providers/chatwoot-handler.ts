import { type ProviderHandler } from "../provider-types";

export const chatwootHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Chatwoot does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Chatwoot does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CHATWOOT_TOKEN";
  },
};
