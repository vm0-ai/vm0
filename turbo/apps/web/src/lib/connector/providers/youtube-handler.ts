import { type ProviderHandler } from "../provider-types";

export const youtubeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("YouTube does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("YouTube does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "YOUTUBE_TOKEN",
};
