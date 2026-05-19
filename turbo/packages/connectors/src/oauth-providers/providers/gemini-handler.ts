import { type ProviderHandler } from "../provider-types";

export const geminiHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Gemini does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Gemini does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "GEMINI_TOKEN";
  },
};
