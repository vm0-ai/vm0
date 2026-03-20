import { type ProviderHandler } from "../provider-types";

export const customerIoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Customer.io does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Customer.io does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "CUSTOMERIO_APP_TOKEN",
};
