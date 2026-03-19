import { type ProviderHandler } from "../provider-types";

export const gitlabHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("GitLab does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("GitLab does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "GITLAB_TOKEN",
};
