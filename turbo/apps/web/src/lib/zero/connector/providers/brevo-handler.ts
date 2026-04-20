import { type ProviderHandler } from "../provider-types";

export const brevoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Brevo does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Brevo does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BREVO_TOKEN";
  },
};
