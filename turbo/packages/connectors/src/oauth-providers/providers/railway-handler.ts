import { type ProviderHandler } from "../provider-types";

export const railwayHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Railway does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Railway does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "RAILWAY_TOKEN";
  },
};
