import { type ProviderHandler } from "../provider-types";

export const intercomHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Intercom does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Intercom does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "INTERCOM_TOKEN";
  },
};
