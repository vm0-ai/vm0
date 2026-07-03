import {
  integrationsGithubContract,
  type GithubInstallationNotFoundResponse,
  type GithubInstallationResponse,
} from "@vm0/api-contracts/contracts/integrations-github";
import { mockApi } from "../msw-contract.ts";

const defaultMissingGithubIntegration: GithubInstallationNotFoundResponse = {
  error: { message: "GitHub installation not found", code: "NOT_FOUND" },
};

const defaultGithubInstallation: GithubInstallationResponse = {
  installation: {
    id: "a0000000-0000-4000-a000-000000000001",
    installationId: "123456",
    status: "active",
    targetName: "vm0-test",
    targetType: "Organization",
    isAdmin: true,
  },
  isConnected: true,
  connectedGithubUserId: "98765",
  connectedGithubUsername: "octocat",
  connectUrl:
    "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id",
};

let mockGithubIntegration: GithubInstallationResponse | null = null;

export function resetMockGithubIntegration(): void {
  mockGithubIntegration = null;
}

export function setMockGithubIntegration(
  integration: GithubInstallationResponse | null,
): void {
  mockGithubIntegration = integration ? structuredClone(integration) : null;
}

export function createDefaultMockGithubIntegration(
  overrides: Partial<GithubInstallationResponse> = {},
): GithubInstallationResponse {
  return {
    ...structuredClone(defaultGithubInstallation),
    ...overrides,
  };
}

export const apiIntegrationsGithubHandlers = [
  mockApi(integrationsGithubContract.getInstallation, ({ respond }) => {
    if (!mockGithubIntegration) {
      return respond(404, defaultMissingGithubIntegration);
    }
    return respond(200, mockGithubIntegration);
  }),

  mockApi(integrationsGithubContract.connectUser, ({ body, respond }) => {
    if (!mockGithubIntegration) {
      return respond(404, {
        error: { message: "GitHub installation not found", code: "NOT_FOUND" },
      });
    }
    const connectSignature = body?.connectSignature;
    mockGithubIntegration = {
      ...mockGithubIntegration,
      isConnected: true,
      connectedGithubUserId:
        connectSignature?.githubUserId ??
        mockGithubIntegration.connectedGithubUserId ??
        "98765",
      connectedGithubUsername:
        connectSignature?.githubUsername ??
        mockGithubIntegration.connectedGithubUsername ??
        "octocat",
    };
    return respond(200, { ok: true });
  }),
];
