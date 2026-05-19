import { type ProviderHandler } from "../provider-types";

export const faireHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Faire OAuth is not configured — use access token auth");
  },
  exchangeCode() {
    throw new Error("Faire OAuth is not configured — use access token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "FAIRE_TOKEN";
  },
};
