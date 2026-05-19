import { type ProviderHandler } from "../provider-types";

export const aviationstackHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("AviationStack does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("AviationStack does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "AVIATIONSTACK_TOKEN";
  },
};
