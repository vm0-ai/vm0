import { type ProviderHandler } from "../provider-types";

export const calendlyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Calendly does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Calendly does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CALENDLY_TOKEN";
  },
};
