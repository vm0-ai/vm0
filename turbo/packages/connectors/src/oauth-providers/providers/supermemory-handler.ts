import { type ProviderHandler } from "../provider-types";

export const supermemoryHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Supermemory does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Supermemory does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SUPERMEMORY_API_KEY";
  },
};
