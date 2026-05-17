import { type ProviderHandler } from "../provider-types";

export const mossHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Moss does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Moss does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MOSS_PROJECT_KEY";
  },
};
