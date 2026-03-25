/**
 * Org-scoped Telegram Integration API Handlers
 *
 * Mock handlers for /api/zero/integrations/telegram endpoints.
 * Default behavior: org has a Telegram bot installed and current user is connected.
 */

import { http, HttpResponse } from "msw";

interface MockTelegramOrgData {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  enabled: boolean;
  bot: { id: string; username: string } | null;
  defaultAgentName: string | null;
  agentOrgSlug: string | null;
  domainConfigured: boolean;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

let mockTelegramData: MockTelegramOrgData = {
  isConnected: true,
  isInstalled: true,
  isAdmin: true,
  enabled: true,
  bot: { id: "bot_123", username: "test_bot" },
  defaultAgentName: "default-agent",
  agentOrgSlug: "test-org",
  domainConfigured: true,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

const defaultData = (): MockTelegramOrgData => ({
  isConnected: true,
  isInstalled: true,
  isAdmin: true,
  enabled: true,
  bot: { id: "bot_123", username: "test_bot" },
  defaultAgentName: "default-agent",
  agentOrgSlug: "test-org",
  domainConfigured: true,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
});

export function resetMockTelegramIntegration(): void {
  mockTelegramData = defaultData();
}

export const apiIntegrationsTelegramHandlers = [
  // GET /api/zero/integrations/telegram
  http.get("/api/zero/integrations/telegram", () => {
    return HttpResponse.json(mockTelegramData);
  }),

  // POST /api/zero/integrations/telegram/install
  http.post("/api/zero/integrations/telegram/install", () => {
    mockTelegramData = {
      ...mockTelegramData,
      isInstalled: true,
      isConnected: true,
      enabled: true,
      bot: { id: "bot_456", username: "installed_bot" },
    };
    return HttpResponse.json(
      {
        installationId: "installation_1",
        bot: mockTelegramData.bot,
      },
      { status: 201 },
    );
  }),

  // POST /api/zero/integrations/telegram/connect
  http.post("/api/zero/integrations/telegram/connect", () => {
    mockTelegramData = { ...mockTelegramData, isConnected: true };
    return HttpResponse.json({
      botUsername: mockTelegramData.bot?.username ?? null,
      telegramUserId: "tg_user_1",
    });
  }),

  // PATCH /api/zero/integrations/telegram
  http.patch("/api/zero/integrations/telegram", async ({ request }) => {
    const body = (await request.json()) as {
      enabled?: boolean;
      agentName?: string;
    };
    if (body.enabled !== undefined) {
      mockTelegramData = { ...mockTelegramData, enabled: body.enabled };
    }
    if (body.agentName !== undefined) {
      mockTelegramData = {
        ...mockTelegramData,
        defaultAgentName: body.agentName,
      };
    }
    return HttpResponse.json({ ok: true });
  }),

  // DELETE /api/zero/integrations/telegram
  http.delete("/api/zero/integrations/telegram", ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("action") === "uninstall") {
      mockTelegramData = {
        ...mockTelegramData,
        isInstalled: false,
        isConnected: false,
        enabled: false,
        bot: null,
      };
    } else {
      mockTelegramData = { ...mockTelegramData, isConnected: false };
    }
    return HttpResponse.json({ ok: true });
  }),
];
