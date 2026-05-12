import { type ProviderHandler } from "../provider-types";

export const minioHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("MinIO does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("MinIO does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MINIO_TOKEN";
  },
};
