import { type ProviderHandler } from "../provider-types";

export const huggingFaceHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Hugging Face does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Hugging Face does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "HUGGING_FACE_TOKEN",
};
