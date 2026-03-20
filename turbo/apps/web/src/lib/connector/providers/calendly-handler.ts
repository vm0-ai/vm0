import { type ProviderHandler } from "../provider-types";

export const calendlyHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Calendly does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Calendly does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "CALENDLY_TOKEN",
};
