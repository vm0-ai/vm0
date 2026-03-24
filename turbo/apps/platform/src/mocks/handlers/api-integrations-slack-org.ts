/**
 * Org-aware Slack Integration API Handlers
 *
 * Mock handlers for /api/zero/integrations/slack endpoint.
 * Default behavior: user has a connected org Slack workspace.
 */

import { http, HttpResponse } from "msw";

interface MockSlackOrgData {
  isConnected: boolean;
  isInstalled: boolean;
  workspaceName: string | null;
  isAdmin: boolean;
  installUrl?: string | null;
  connectUrl?: string | null;
  defaultAgentId: string | null;
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
  isInstalled: true,
  workspaceName: "Test Org Workspace",
  isAdmin: true,
  defaultAgentId: "default-agent",
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
    isInstalled: true,
    workspaceName: "Test Org Workspace",
    isAdmin: true,
    defaultAgentId: "default-agent",
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
  // GET /api/zero/integrations/slack
  http.get("/api/zero/integrations/slack", () => {
    return HttpResponse.json(mockSlackOrgData);
  }),

  // DELETE /api/zero/integrations/slack
  http.delete("/api/zero/integrations/slack", () => {
    mockSlackOrgData = { ...mockSlackOrgData, isConnected: false };
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/zero/slack/channels
  http.get("*/api/zero/slack/channels", () => {
    if (!mockSlackOrgData.isInstalled) {
      return HttpResponse.json(
        { error: { message: "No Slack installation", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json({
      channels: [
        { id: "C-GENERAL", name: "general" },
        { id: "C-ALERTS", name: "alerts" },
      ],
    });
  }),
];
