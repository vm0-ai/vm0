import { type ProviderHandler } from "../provider-types";

export const hunterHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Hunter does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Hunter does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "HUNTER_TOKEN";
  },
};
