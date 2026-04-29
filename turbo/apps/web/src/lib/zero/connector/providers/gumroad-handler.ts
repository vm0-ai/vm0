import { type ProviderHandler } from "../provider-types";

export const gumroadHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Gumroad does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Gumroad does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GUMROAD_TOKEN";
  },
};
