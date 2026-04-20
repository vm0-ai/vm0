import { type ProviderHandler } from "../provider-types";

export const minimaxHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("MiniMax does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("MiniMax does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MINIMAX_TOKEN";
  },
};
