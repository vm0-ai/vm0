import { type ProviderHandler } from "../provider-types";

export const calComHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cal.com does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cal.com does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CALCOM_TOKEN";
  },
};
