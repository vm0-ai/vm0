import { type ProviderHandler } from "../provider-types";

export const servicenowHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ServiceNow does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("ServiceNow does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SERVICENOW_USERNAME";
  },
};
