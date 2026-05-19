import { type ProviderHandler } from "../provider-types";

export const checkrHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Checkr does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Checkr does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CHECKR_TOKEN";
  },
};
