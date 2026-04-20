import { type ProviderHandler } from "../provider-types";

export const jiraHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Jira does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Jira does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "JIRA_API_TOKEN";
  },
};
