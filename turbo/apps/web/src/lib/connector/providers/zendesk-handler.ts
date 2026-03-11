import { type ProviderHandler } from "../provider-types";

export const zendeskHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Zendesk does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Zendesk does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "ZENDESK_API_TOKEN",
};
