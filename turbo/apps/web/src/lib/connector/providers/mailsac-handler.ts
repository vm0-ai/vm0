import { type ProviderHandler } from "../provider-types";

export const mailsacHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mailsac does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Mailsac does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "MAILSAC_TOKEN",
};
