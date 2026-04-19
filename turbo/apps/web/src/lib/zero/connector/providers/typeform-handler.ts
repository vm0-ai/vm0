import { type ProviderHandler } from "../provider-types";

export const typeformHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Typeform does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Typeform does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TYPEFORM_TOKEN";
  },
};
