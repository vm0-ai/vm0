import { type ProviderHandler } from "../provider-types";

export const bitrixHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Bitrix does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Bitrix does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "BITRIX_WEBHOOK_URL",
};
