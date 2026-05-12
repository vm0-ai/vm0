import { type ProviderHandler } from "../provider-types";

export const workosHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("WorkOS does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("WorkOS does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "WORKOS_TOKEN";
  },
};
