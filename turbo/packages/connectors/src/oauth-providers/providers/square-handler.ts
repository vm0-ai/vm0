import { type ProviderHandler } from "../provider-types";

export const squareHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Square does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Square does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SQUARE_TOKEN";
  },
};
