import {
  integrationsGithubContract,
  type GithubInstallationNotFoundResponse,
  type GithubInstallationResponse,
  type GithubLabelListener,
} from "@vm0/api-contracts/contracts/integrations-github";
import { mockApi } from "../msw-contract.ts";

const defaultMissingGithubIntegration: GithubInstallationNotFoundResponse = {
  error: { message: "GitHub installation not found", code: "NOT_FOUND" },
  installUrl: "https://github.com/apps/vm0-test/installations/new?state=abc",
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
  installUrl: "https://github.com/apps/vm0-test/installations/new?state=abc",
  connectUrl:
    "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id",
  agent: {
    id: "c0000000-0000-4000-a000-000000000001",
    name: "zero",
  },
  environment: {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
  labelListeners: [],
};

let mockGithubIntegration: GithubInstallationResponse | null = null;
let mockGithubListenerCounter = 0;

function normalizeLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

function listenerAgentName(agentId: string): string {
  return agentId === defaultGithubInstallation.agent?.id ? "zero" : agentId;
}

function createMockListener(
  body: {
    readonly labelName: string;
    readonly agentId: string;
    readonly triggerMode: GithubLabelListener["triggerMode"];
    readonly prompt: string;
    readonly enabled?: boolean;
  },
  id: string,
): GithubLabelListener {
  const now = new Date(0).toISOString();
  return {
    id,
    labelName: body.labelName.trim(),
    triggerMode: body.triggerMode,
    prompt: body.prompt.trim(),
    enabled: body.enabled ?? true,
    canManage: true,
    agent: {
      id: body.agentId,
      name: listenerAgentName(body.agentId),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function getExistingListener(labelName: string): GithubLabelListener | null {
  const normalized = normalizeLabelName(labelName);
  return (
    mockGithubIntegration?.labelListeners.find((listener) => {
      return normalizeLabelName(listener.labelName) === normalized;
    }) ?? null
  );
}

export function resetMockGithubIntegration(): void {
  mockGithubIntegration = null;
  mockGithubListenerCounter = 0;
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

export function getMockGithubIntegration(): GithubInstallationResponse | null {
  return mockGithubIntegration ? structuredClone(mockGithubIntegration) : null;
}

export const apiIntegrationsGithubHandlers = [
  mockApi(integrationsGithubContract.getInstallation, ({ respond }) => {
    if (!mockGithubIntegration) {
      return respond(404, defaultMissingGithubIntegration);
    }
    return respond(200, mockGithubIntegration);
  }),

  mockApi(integrationsGithubContract.connectUser, ({ respond }) => {
    if (!mockGithubIntegration) {
      return respond(404, {
        error: { message: "GitHub installation not found", code: "NOT_FOUND" },
      });
    }
    mockGithubIntegration = {
      ...mockGithubIntegration,
      isConnected: true,
      connectedGithubUserId:
        mockGithubIntegration.connectedGithubUserId ?? "98765",
      connectedGithubUsername:
        mockGithubIntegration.connectedGithubUsername ?? "octocat",
    };
    return respond(200, { ok: true });
  }),

  mockApi(integrationsGithubContract.disconnectUser, ({ respond }) => {
    if (!mockGithubIntegration) {
      return respond(404, {
        error: { message: "GitHub installation not found", code: "NOT_FOUND" },
      });
    }
    mockGithubIntegration = {
      ...mockGithubIntegration,
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
    };
    return respond(200, { ok: true });
  }),

  mockApi(integrationsGithubContract.deleteInstallation, ({ respond }) => {
    mockGithubIntegration = null;
    return respond(200, { ok: true });
  }),

  mockApi(
    integrationsGithubContract.updateInstallation,
    ({ body, respond }) => {
      if (!mockGithubIntegration) {
        return respond(404, {
          error: {
            message: "GitHub installation not found",
            code: "NOT_FOUND",
          },
        });
      }
      mockGithubIntegration = {
        ...mockGithubIntegration,
        agent: mockGithubIntegration.agent
          ? { ...mockGithubIntegration.agent, name: body.agentName }
          : null,
      };
      return respond(200, { ok: true });
    },
  ),

  mockApi(
    integrationsGithubContract.createLabelListener,
    ({ body, respond }) => {
      if (!mockGithubIntegration) {
        return respond(404, {
          error: {
            message: "GitHub installation not found",
            code: "NOT_FOUND",
          },
        });
      }
      if (getExistingListener(body.labelName)) {
        return respond(409, {
          error: { message: "Label listener already exists", code: "CONFLICT" },
        });
      }

      mockGithubListenerCounter += 1;
      const listener = createMockListener(
        body,
        `b0000000-0000-4000-a000-${String(mockGithubListenerCounter).padStart(
          12,
          "0",
        )}`,
      );
      mockGithubIntegration = {
        ...mockGithubIntegration,
        labelListeners: [...mockGithubIntegration.labelListeners, listener],
      };
      return respond(201, { listener });
    },
  ),

  mockApi(
    integrationsGithubContract.updateLabelListener,
    ({ params, body, respond }) => {
      if (!mockGithubIntegration) {
        return respond(404, {
          error: {
            message: "GitHub installation not found",
            code: "NOT_FOUND",
          },
        });
      }
      const listener = mockGithubIntegration.labelListeners.find((item) => {
        return item.id === params.listenerId;
      });
      if (!listener) {
        return respond(404, {
          error: { message: "Label listener not found", code: "NOT_FOUND" },
        });
      }
      if (!listener.canManage) {
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      }
      if (body.labelName) {
        const duplicate = getExistingListener(body.labelName);
        if (duplicate && duplicate.id !== listener.id) {
          return respond(409, {
            error: {
              message: "Label listener already exists",
              code: "CONFLICT",
            },
          });
        }
      }

      const updated: GithubLabelListener = {
        ...listener,
        labelName: body.labelName?.trim() ?? listener.labelName,
        triggerMode: body.triggerMode ?? listener.triggerMode,
        prompt: body.prompt?.trim() ?? listener.prompt,
        enabled: body.enabled ?? listener.enabled,
        agent: body.agentId
          ? { id: body.agentId, name: listenerAgentName(body.agentId) }
          : listener.agent,
        updatedAt: new Date(1).toISOString(),
      };
      mockGithubIntegration = {
        ...mockGithubIntegration,
        labelListeners: mockGithubIntegration.labelListeners.map((item) => {
          return item.id === updated.id ? updated : item;
        }),
      };
      return respond(200, { listener: updated });
    },
  ),

  mockApi(
    integrationsGithubContract.deleteLabelListener,
    ({ params, respond }) => {
      if (!mockGithubIntegration) {
        return respond(404, {
          error: {
            message: "GitHub installation not found",
            code: "NOT_FOUND",
          },
        });
      }
      const listener = mockGithubIntegration.labelListeners.find((item) => {
        return item.id === params.listenerId;
      });
      if (!listener) {
        return respond(404, {
          error: { message: "Label listener not found", code: "NOT_FOUND" },
        });
      }
      if (!listener.canManage) {
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      }
      mockGithubIntegration = {
        ...mockGithubIntegration,
        labelListeners: mockGithubIntegration.labelListeners.filter((item) => {
          return item.id !== params.listenerId;
        }),
      };
      return respond(200, { ok: true });
    },
  ),
];
