import { type ProviderHandler } from "../provider-types";

export const atlascloudHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Atlas Cloud does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Atlas Cloud does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ATLASCLOUD_API_KEY";
  },
};
