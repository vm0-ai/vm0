import { type ProviderHandler } from "../provider-types";

export const openaiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("OpenAI does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("OpenAI does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "OPENAI_TOKEN";
  },
};
