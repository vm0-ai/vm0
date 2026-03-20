import { type ProviderHandler } from "../provider-types";

export const v0Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("v0 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("v0 does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "V0_TOKEN",
};
