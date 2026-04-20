import { type ProviderHandler } from "../provider-types";

export const metabaseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Metabase does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Metabase does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "METABASE_TOKEN";
  },
};
