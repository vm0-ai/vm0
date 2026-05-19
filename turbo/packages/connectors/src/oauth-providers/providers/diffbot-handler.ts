import { type ProviderHandler } from "../provider-types";

export const diffbotHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Diffbot does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Diffbot does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DIFFBOT_TOKEN";
  },
};
