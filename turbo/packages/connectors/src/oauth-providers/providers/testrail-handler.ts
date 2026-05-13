import { type ProviderHandler } from "../provider-types";

export const testrailHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("TestRail does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("TestRail does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TESTRAIL_TOKEN";
  },
};
