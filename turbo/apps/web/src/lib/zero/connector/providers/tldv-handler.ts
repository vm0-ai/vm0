import { type ProviderHandler } from "../provider-types";

export const tldvHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("tl;dv does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("tl;dv does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TLDV_TOKEN";
  },
};
