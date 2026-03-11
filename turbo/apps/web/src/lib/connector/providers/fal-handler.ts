import { type ProviderHandler } from "../provider-types";

export const falHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("fal.ai does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("fal.ai does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "FAL_TOKEN",
};
