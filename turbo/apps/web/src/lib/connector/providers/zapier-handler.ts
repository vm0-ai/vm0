import { type ProviderHandler } from "../provider-types";

export const zapierHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Zapier does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Zapier does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "ZAPIER_TOKEN",
};
