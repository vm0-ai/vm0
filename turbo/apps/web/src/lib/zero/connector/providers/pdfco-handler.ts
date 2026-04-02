import { type ProviderHandler } from "../provider-types";

export const pdfcoHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("PDF.co does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("PDF.co does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PDFCO_TOKEN";
  },
};
