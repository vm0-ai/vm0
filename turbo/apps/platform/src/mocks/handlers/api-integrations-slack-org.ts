/**
 * Org-aware Slack Integration API Handlers
 *
 * Mock handlers for /api/integrations/slack/org endpoint.
 * Default behavior: user has a connected org Slack workspace.
 */

import { http, HttpResponse } from "msw";

interface MockSlackOrgData {
  isConnected: boolean;
  workspaceName: string | null;
  isAdmin: boolean;
  defaultAgentName: string | null;
  agentOrgSlug: string | null;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

let mockSlackOrgData: MockSlackOrgData = {
  isConnected: true,
  workspaceName: "Test Org Workspace",
  isAdmin: true,
  defaultAgentName: "default-agent",
  agentOrgSlug: "test-org",
  environment: {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

export function resetMockSlackOrgIntegration(): void {
  mockSlackOrgData = {
    isConnected: true,
    workspaceName: "Test Org Workspace",
    isAdmin: true,
    defaultAgentName: "default-agent",
    agentOrgSlug: "test-org",
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsSlackOrgHandlers = [
  // GET /api/integrations/slack/org
  http.get("/api/integrations/slack/org", () => {
    return HttpResponse.json(mockSlackOrgData);
  }),

  // DELETE /api/integrations/slack/org
  http.delete("/api/integrations/slack/org", () => {
    mockSlackOrgData = { ...mockSlackOrgData, isConnected: false };
    return HttpResponse.json({ ok: true });
  }),
];
