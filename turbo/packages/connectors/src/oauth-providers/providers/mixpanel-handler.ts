import { type ProviderHandler } from "../provider-types";

export const mixpanelHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mixpanel does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Mixpanel does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MIXPANEL_SERVICE_ACCOUNT_SECRET";
  },
};
