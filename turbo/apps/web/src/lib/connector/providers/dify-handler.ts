import { type ProviderHandler } from "../provider-types";

export const difyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Dify does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Dify does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "DIFY_TOKEN",
};
