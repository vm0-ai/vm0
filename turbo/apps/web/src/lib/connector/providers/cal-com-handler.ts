import { type ProviderHandler } from "../provider-types";

export const calComHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cal.com does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cal.com does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "CALCOM_TOKEN",
};
