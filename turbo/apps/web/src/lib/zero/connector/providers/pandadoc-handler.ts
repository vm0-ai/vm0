import { type ProviderHandler } from "../provider-types";

export const pandadocHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PandaDoc does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("PandaDoc does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PANDADOC_TOKEN";
  },
};
