import { type ProviderHandler } from "../provider-types";

export const mem0Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mem0 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Mem0 does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MEM0_TOKEN";
  },
};
