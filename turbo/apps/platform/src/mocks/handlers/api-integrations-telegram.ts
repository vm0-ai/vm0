import {
  zeroIntegrationsTelegramContract,
  type TelegramLinkStatusResponse,
  type TelegramStatusResponse,
} from "@vm0/core/contracts/zero-integrations-telegram";
import { mockApi } from "../msw-contract.ts";

const defaultTelegramData: TelegramStatusResponse = {
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

let mockTelegramData: TelegramStatusResponse =
  structuredClone(defaultTelegramData);

// Default link-status: unlinked with no installation. Tests that need the
// linked (telegramUserId) or unlinked-with-installation variants should
// override this handler via server.use(mockApi(zeroIntegrationsTelegramContract.getLinkStatus, …)).
let mockLinkStatus: TelegramLinkStatusResponse = { linked: false };

export function resetMockTelegramIntegration(): void {
  mockTelegramData = structuredClone(defaultTelegramData);
  mockLinkStatus = { linked: false };
}

export const apiIntegrationsTelegramHandlers = [
  mockApi(zeroIntegrationsTelegramContract.getStatus, ({ respond }) => {
    return respond(200, mockTelegramData);
  }),

  mockApi(zeroIntegrationsTelegramContract.update, ({ body, respond }) => {
    if (body.agentName && mockTelegramData.agent) {
      mockTelegramData.agent.name = body.agentName;
    }
    return respond(200, { ok: true });
  }),

  mockApi(zeroIntegrationsTelegramContract.disconnect, ({ respond }) => {
    return respond(204);
  }),

  mockApi(zeroIntegrationsTelegramContract.getLinkStatus, ({ respond }) => {
    return respond(200, mockLinkStatus);
  }),

  mockApi(zeroIntegrationsTelegramContract.register, ({ respond }) => {
    return respond(201, {
      id: "installation_1",
      botId: "bot_123",
      botUsername: "test_bot",
      webhookUrl: "http://localhost/api/telegram/webhook/installation_1",
      domainConfigured: false,
    });
  }),
];
