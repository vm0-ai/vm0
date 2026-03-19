import { type ProviderHandler } from "../provider-types";

export const htmlcsstoimageHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "HTML/CSS to Image does not support OAuth — use API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "HTML/CSS to Image does not support OAuth — use API token auth",
    );
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "HCTI_API_KEY",
};
