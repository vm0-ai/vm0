import { type ProviderHandler } from "../provider-types";

export const greenhouseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Greenhouse does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Greenhouse does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GREENHOUSE_TOKEN";
  },
};
