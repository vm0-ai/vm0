import { type ProviderHandler } from "../provider-types";

export const pdforgeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PDForge does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("PDForge does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PDFORGE_API_KEY";
  },
};
