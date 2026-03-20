import { type ProviderHandler } from "../provider-types";

export const salesforceHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Salesforce does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Salesforce does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "SALESFORCE_TOKEN",
};
