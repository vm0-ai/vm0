import { type ProviderHandler } from "../provider-types";

export const reporteiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Reportei does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Reportei does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "REPORTEI_TOKEN",
};
