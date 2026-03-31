import { type ProviderHandler } from "../provider-types";

export const customerIoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Customer.io does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Customer.io does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CUSTOMERIO_APP_TOKEN";
  },
};
