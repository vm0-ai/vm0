import { type ProviderHandler } from "../provider-types";

export const cloudflareHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cloudflare does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cloudflare does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CLOUDFLARE_TOKEN";
  },
};
