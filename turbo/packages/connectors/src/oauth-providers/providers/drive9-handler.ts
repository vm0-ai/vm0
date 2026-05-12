import { type ProviderHandler } from "../provider-types";

export const drive9Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("drive9 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("drive9 does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DRIVE9_TOKEN";
  },
};
