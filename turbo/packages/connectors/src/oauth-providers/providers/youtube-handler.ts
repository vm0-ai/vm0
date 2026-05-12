import { type ProviderHandler } from "../provider-types";

export const youtubeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("YouTube does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("YouTube does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "YOUTUBE_TOKEN";
  },
};
