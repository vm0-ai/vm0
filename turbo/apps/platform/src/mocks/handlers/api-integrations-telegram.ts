/**
 * Telegram Integration API Handlers
 *
 * Mock handlers for /api/integrations/telegram and /api/telegram/register endpoints.
 * Default behavior: user has a linked Telegram bot with an agent configured.
 */

import {
  zeroIntegrationsTelegramContract,
  type TelegramStatusResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockTelegramData: TelegramStatusResponse = {
  installationId: "install_123",
  bot: { id: "bot_123", username: "test_bot" },
  agent: { id: "compose_1", name: "default-agent" },
  isAdmin: true,
  isConnected: true,
  domainConfigured: false,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

export function resetMockTelegramIntegration(): void {
  mockTelegramData = {
    installationId: "install_123",
    bot: { id: "bot_123", username: "test_bot" },
    agent: { id: "compose_1", name: "default-agent" },
    isAdmin: true,
    isConnected: true,
    domainConfigured: false,
    environment: {
      requiredSecrets: ["ANTHROPIC_API_KEY"],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

export const apiIntegrationsTelegramHandlers = [
  mockApi(zeroIntegrationsTelegramContract.getStatus, ({ respond }) => {
    return respond(200, mockTelegramData);
  }),

  mockApi(zeroIntegrationsTelegramContract.update, ({ body, respond }) => {
    if (body?.agentName && mockTelegramData.agent) {
      mockTelegramData.agent.name = body.agentName;
    }
    return respond(200, { ok: true });
  }),

  mockApi(zeroIntegrationsTelegramContract.disconnect, ({ respond }) => {
    return respond(204);
  }),

  mockApi(zeroIntegrationsTelegramContract.getLinkStatus, ({ respond }) => {
    return respond(200, { linked: false });
  }),

  mockApi(zeroIntegrationsTelegramContract.register, ({ respond }) => {
    return respond(201, {
      id: "installation_1",
      botId: "bot_123",
      botUsername: "test_bot",
      webhookUrl: "https://example.com/api/telegram/webhook/installation_1",
      domainConfigured: false,
    });
  }),
];
