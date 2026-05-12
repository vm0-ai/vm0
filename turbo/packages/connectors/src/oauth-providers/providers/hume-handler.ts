import { type ProviderHandler } from "../provider-types";

export const humeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Hume does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Hume does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "HUME_TOKEN";
  },
};
