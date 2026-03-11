import { type ProviderHandler } from "../provider-types";

export const wrikeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Wrike does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Wrike does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "WRIKE_TOKEN",
};
