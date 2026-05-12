import { type ProviderHandler } from "../provider-types";

export const remoteAgentHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Remote Agent does not support OAuth");
  },
  exchangeCode() {
    throw new Error("Remote Agent does not support OAuth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "REMOTE_AGENT";
  },
};
