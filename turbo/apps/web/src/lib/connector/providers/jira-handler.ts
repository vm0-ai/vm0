import { type ProviderHandler } from "../provider-types";

export const jiraHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Jira does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Jira does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "JIRA_API_TOKEN",
};
