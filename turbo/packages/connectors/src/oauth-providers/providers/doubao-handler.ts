import { type ProviderHandler } from "../provider-types";

export const doubaoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Doubao does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Doubao does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DOUBAO_API_KEY";
  },
};
