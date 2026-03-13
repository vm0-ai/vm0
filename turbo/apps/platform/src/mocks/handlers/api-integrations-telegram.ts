/**
 * Telegram Integration API Handlers
 *
 * Mock handlers for /api/integrations/telegram and /api/telegram/register endpoints.
 * Default behavior: user has a linked Telegram bot with an agent configured.
 */

import { http, HttpResponse } from "msw";

interface MockTelegramIntegrationData {
  bot: { id: string; username: string };
  agent: { id: string; name: string; orgSlug: string } | null;
  isAdmin: boolean;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

let mockTelegramData: MockTelegramIntegrationData = {
  bot: { id: "bot_123", username: "test_bot" },
  agent: { id: "compose_1", name: "default-agent", orgSlug: "test-scope" },
  isAdmin: true,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

export function resetMockTelegramIntegration(): void {
  mockTelegramData = {
    bot: { id: "bot_123", username: "test_bot" },
    agent: {
      id: "compose_1",
      name: "default-agent",
      orgSlug: "test-scope",
    },
    isAdmin: true,
    environment: {
      requiredSecrets: ["ANTHROPIC_API_KEY"],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsTelegramHandlers = [
  // GET /api/integrations/telegram
  http.get("/api/integrations/telegram", () => {
    return HttpResponse.json(mockTelegramData);
  }),

  // PATCH /api/integrations/telegram
  http.patch("/api/integrations/telegram", async ({ request }) => {
    const body = (await request.json()) as { agentName?: string };
    if (body.agentName && mockTelegramData.agent) {
      mockTelegramData.agent.name = body.agentName;
    }
    return HttpResponse.json({ ok: true });
  }),

  // DELETE /api/integrations/telegram
  http.delete("/api/integrations/telegram", () => {
    return HttpResponse.json({ ok: true });
  }),

  // GET /api/integrations/telegram/link
  http.get("/api/integrations/telegram/link", () => {
    return HttpResponse.json({ linked: false });
  }),

  // POST /api/telegram/register
  http.post("/api/telegram/register", () => {
    return HttpResponse.json({
      id: "installation_1",
      botUsername: "test_bot",
    });
  }),
];
