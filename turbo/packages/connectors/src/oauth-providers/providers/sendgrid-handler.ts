import { type ProviderHandler } from "../provider-types";

export const sendgridHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("SendGrid does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("SendGrid does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SENDGRID_TOKEN";
  },
};
