import { type ProviderHandler } from "../provider-types";

export const bitrixHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Bitrix does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Bitrix does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BITRIX_WEBHOOK_URL";
  },
};
