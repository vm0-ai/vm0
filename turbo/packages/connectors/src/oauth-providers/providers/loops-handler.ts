import { type ProviderHandler } from "../provider-types";

export const loopsHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Loops does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Loops does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LOOPS_TOKEN";
  },
};
