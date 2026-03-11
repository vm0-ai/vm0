import { type ProviderHandler } from "../provider-types";

export const metabaseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Metabase does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Metabase does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "METABASE_TOKEN",
};
