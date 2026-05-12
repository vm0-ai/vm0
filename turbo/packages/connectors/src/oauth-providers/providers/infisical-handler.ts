import { type ProviderHandler } from "../provider-types";

export const infisicalHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Infisical does not support OAuth — use Machine Identity auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Infisical does not support OAuth — use Machine Identity auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "INFISICAL_TOKEN";
  },
};
