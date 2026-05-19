import { type ProviderHandler } from "../provider-types";

export const brexHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Brex OAuth is not configured — use API token auth");
  },
  exchangeCode() {
    throw new Error("Brex OAuth is not configured — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "BREX_TOKEN";
  },
};
