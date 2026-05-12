import { type ProviderHandler } from "../provider-types";

export const pdf4meHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PDF4me does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("PDF4me does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PDF4ME_TOKEN";
  },
};
