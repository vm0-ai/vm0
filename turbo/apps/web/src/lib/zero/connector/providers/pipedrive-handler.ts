import { type ProviderHandler } from "../provider-types";

export const pipedriveHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Pipedrive does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Pipedrive does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PIPEDRIVE_TOKEN";
  },
};
