import { type ProviderHandler } from "../provider-types";

export const deepseekHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("DeepSeek does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("DeepSeek does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "DEEPSEEK_TOKEN";
  },
};
