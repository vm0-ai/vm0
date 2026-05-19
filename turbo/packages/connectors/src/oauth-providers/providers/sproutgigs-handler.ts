import { type ProviderHandler } from "../provider-types";

export const sproutgigsHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("SproutGigs does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("SproutGigs does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SPROUTGIGS_API_SECRET";
  },
};
