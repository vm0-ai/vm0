import { type ProviderHandler } from "../provider-types";

export const freshdeskHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Freshdesk does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Freshdesk does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "FRESHDESK_TOKEN";
  },
};
