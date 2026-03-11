import { type ProviderHandler } from "../provider-types";

export const resendHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Resend does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("Resend does not support OAuth — use API key auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "RESEND_API_KEY",
};
