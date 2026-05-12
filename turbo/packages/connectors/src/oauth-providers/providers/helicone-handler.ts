import { type ProviderHandler } from "../provider-types";

export const heliconeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Helicone does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Helicone does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "HELICONE_TOKEN";
  },
};
