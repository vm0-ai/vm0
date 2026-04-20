import { type ProviderHandler } from "../provider-types";

export const togetherHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Together AI does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Together AI does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TOGETHER_TOKEN";
  },
};
