import { type ProviderHandler } from "../provider-types";

export const langsmithHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("LangSmith does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("LangSmith does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LANGSMITH_TOKEN";
  },
};
