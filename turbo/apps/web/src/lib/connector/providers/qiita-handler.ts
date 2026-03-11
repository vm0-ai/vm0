import { type ProviderHandler } from "../provider-types";

export const qiitaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Qiita does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Qiita does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "QIITA_TOKEN",
};
