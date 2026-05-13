import { type ProviderHandler } from "../provider-types";

export const twilioHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Twilio does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Twilio does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TWILIO_ACCOUNT_SID";
  },
};
