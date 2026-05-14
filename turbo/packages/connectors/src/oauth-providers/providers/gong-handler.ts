import { type ProviderHandler } from "../provider-types";

export const gongHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Gong does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Gong does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GONG_ACCESS_KEY";
  },
};
