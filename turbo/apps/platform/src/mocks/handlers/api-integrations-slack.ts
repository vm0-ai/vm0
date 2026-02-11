/**
 * Slack Integration API Handlers
 *
 * Mock handlers for /api/integrations/slack endpoint.
 * Default behavior: user has a linked Slack workspace with an agent configured.
 */

import { http, HttpResponse } from "msw";

interface MockSlackIntegrationData {
  workspace: { id: string; name: string | null };
  agent: { id: string; name: string } | null;
  isAdmin: boolean;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

let mockSlackData: MockSlackIntegrationData = {
  workspace: { id: "T123", name: "Test Workspace" },
  agent: { id: "compose_1", name: "default-agent" },
  isAdmin: true,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

export function resetMockSlackIntegration(): void {
  mockSlackData = {
    workspace: { id: "T123", name: "Test Workspace" },
    agent: { id: "compose_1", name: "default-agent" },
    isAdmin: true,
    environment: {
      requiredSecrets: ["ANTHROPIC_API_KEY"],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsSlackHandlers = [
  // GET /api/integrations/slack
  http.get("/api/integrations/slack", () => {
    return HttpResponse.json(mockSlackData);
  }),

  // PATCH /api/integrations/slack
  http.patch("/api/integrations/slack", async ({ request }) => {
    const body = (await request.json()) as { agentName?: string };
    if (body.agentName && mockSlackData.agent) {
      mockSlackData.agent.name = body.agentName;
    }
    return HttpResponse.json({ ok: true });
  }),

  // DELETE /api/integrations/slack
  http.delete("/api/integrations/slack", () => {
    return HttpResponse.json({ ok: true });
  }),
];
