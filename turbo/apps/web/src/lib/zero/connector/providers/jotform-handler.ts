import { type ProviderHandler } from "../provider-types";

export const jotformHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Jotform does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Jotform does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "JOTFORM_TOKEN";
  },
};
