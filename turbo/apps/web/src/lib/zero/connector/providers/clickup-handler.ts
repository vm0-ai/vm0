import { type ProviderHandler } from "../provider-types";

export const clickupHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ClickUp does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("ClickUp does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CLICKUP_TOKEN";
  },
};
