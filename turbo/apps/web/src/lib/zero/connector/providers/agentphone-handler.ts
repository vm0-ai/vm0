import { type ProviderHandler } from "../provider-types";

export const agentphoneHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("AgentPhone does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("AgentPhone does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "AGENTPHONE_TOKEN";
  },
};
