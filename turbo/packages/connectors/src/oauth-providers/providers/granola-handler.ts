import { type ProviderHandler } from "../provider-types";

export const granolaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Granola does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Granola does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GRANOLA_TOKEN";
  },
};
