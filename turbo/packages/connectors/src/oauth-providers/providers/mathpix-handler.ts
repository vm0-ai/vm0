import { type ProviderHandler } from "../provider-types";

export const mathpixHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mathpix does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Mathpix does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MATHPIX_APP_KEY";
  },
};
