import { type ProviderHandler } from "../provider-types";

export const pineconeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Pinecone does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Pinecone does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PINECONE_TOKEN";
  },
};
