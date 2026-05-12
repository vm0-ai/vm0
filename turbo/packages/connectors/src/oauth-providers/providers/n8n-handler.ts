import { type ProviderHandler } from "../provider-types";

export const n8nHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("n8n does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("n8n does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "N8N_TOKEN";
  },
};
