import { type ProviderHandler } from "../provider-types";

export const e2bHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("E2B does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("E2B does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "E2B_TOKEN";
  },
};
