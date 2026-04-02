import { type ProviderHandler } from "../provider-types";

export const zendeskHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Zendesk does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Zendesk does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ZENDESK_API_TOKEN";
  },
};
