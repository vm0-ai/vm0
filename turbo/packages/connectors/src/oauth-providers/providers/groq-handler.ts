import { type ProviderHandler } from "../provider-types";

export const groqHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Groq does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Groq does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GROQ_TOKEN";
  },
};
