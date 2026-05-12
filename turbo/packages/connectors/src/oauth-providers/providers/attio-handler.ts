import { type ProviderHandler } from "../provider-types";

export const attioHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Attio does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Attio does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ATTIO_TOKEN";
  },
};
