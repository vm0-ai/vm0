import { type ProviderHandler } from "../provider-types";

export const resendHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Resend does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Resend does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "RESEND_TOKEN";
  },
};
