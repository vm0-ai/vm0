import { type ProviderHandler } from "../provider-types";

export const zeptomailHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "ZeptoMail does not support OAuth — use Send Mail Token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "ZeptoMail does not support OAuth — use Send Mail Token auth",
    );
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "ZEPTOMAIL_TOKEN",
};
