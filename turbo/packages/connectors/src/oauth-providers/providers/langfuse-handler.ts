import { type ProviderHandler } from "../provider-types";

export const langfuseHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Langfuse does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Langfuse does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "LANGFUSE_PUBLIC_KEY";
  },
};
