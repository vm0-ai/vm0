import { type ProviderHandler } from "../provider-types";

export const railwayProjectHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Railway project tokens do not support OAuth — use API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Railway project tokens do not support OAuth — use API token auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "RAILWAY_PROJECT_TOKEN";
  },
};
