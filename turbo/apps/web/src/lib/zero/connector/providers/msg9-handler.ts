import { type ProviderHandler } from "../provider-types";

export const msg9Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("msg9 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("msg9 does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MSG9_TOKEN";
  },
};
