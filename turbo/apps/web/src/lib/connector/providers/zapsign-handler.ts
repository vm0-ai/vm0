import { type ProviderHandler } from "../provider-types";

export const zapsignHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ZapSign does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("ZapSign does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "ZAPSIGN_TOKEN",
};
