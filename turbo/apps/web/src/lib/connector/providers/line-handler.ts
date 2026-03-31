import { type ProviderHandler } from "../provider-types";

export const lineHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("LINE does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("LINE does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LINE_TOKEN";
  },
};
