import { type ProviderHandler } from "../provider-types";

export const granolaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Granola does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Granola does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "GRANOLA_TOKEN",
};
