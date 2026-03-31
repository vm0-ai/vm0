import { type ProviderHandler } from "../provider-types";

export const mailsacHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Mailsac does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Mailsac does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "MAILSAC_TOKEN";
  },
};
