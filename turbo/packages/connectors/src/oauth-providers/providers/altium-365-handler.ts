import { type ProviderHandler } from "../provider-types";

export const altium365Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Altium 365 does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Altium 365 does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ALTIUM365_TOKEN";
  },
};
