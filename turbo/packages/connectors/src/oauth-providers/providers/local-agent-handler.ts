import { type ProviderHandler } from "../provider-types";

export const localAgentHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Local Agent does not support OAuth");
  },
  exchangeCode() {
    throw new Error("Local Agent does not support OAuth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LOCAL_AGENT";
  },
};
