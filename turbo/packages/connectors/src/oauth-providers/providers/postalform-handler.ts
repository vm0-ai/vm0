import { type ProviderHandler } from "../provider-types";

export const postalformHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PostalForm does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("PostalForm does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "POSTALFORM_TOKEN";
  },
};
