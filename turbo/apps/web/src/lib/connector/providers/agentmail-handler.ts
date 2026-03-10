import { type ProviderHandler } from "../provider-types";

export const agentmailHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("AgentMail does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("AgentMail does not support OAuth — use API key auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "AGENTMAIL_TOKEN",
};
