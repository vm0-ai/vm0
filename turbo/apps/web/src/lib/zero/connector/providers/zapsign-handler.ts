import { type ProviderHandler } from "../provider-types";

export const zapsignHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ZapSign does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("ZapSign does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ZAPSIGN_TOKEN";
  },
};
