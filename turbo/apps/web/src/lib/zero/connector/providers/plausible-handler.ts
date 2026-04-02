import { type ProviderHandler } from "../provider-types";

export const plausibleHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Plausible does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Plausible does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PLAUSIBLE_TOKEN";
  },
};
