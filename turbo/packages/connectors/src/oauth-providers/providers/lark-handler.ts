import { type ProviderHandler } from "../provider-types";

export const larkHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Lark does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Lark does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LARK_TOKEN";
  },
};
