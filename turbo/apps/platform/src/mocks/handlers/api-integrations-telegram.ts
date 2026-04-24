import {
  zeroIntegrationsTelegramContract,
  type TelegramBot,
  type TelegramBotStatus,
  type TelegramLinkStatusResponse,
  type TelegramListResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { mockApi } from "../msw-contract.ts";

const defaultTelegramBots: TelegramBot[] = [
  {
    id: "bot_123",
    username: "test_bot",
    agent: { id: "compose_1", name: "default-agent" },
    isOwner: true,
    isConnected: true,
  },
];

const defaultTelegramStatus: TelegramBotStatus = {
  ...defaultTelegramBots[0]!,
  domainConfigured: false,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

let mockTelegramList: TelegramListResponse = {
  bots: structuredClone(defaultTelegramBots),
};
let mockTelegramStatuses: Record<string, TelegramBotStatus> = {
  [defaultTelegramStatus.id]: structuredClone(defaultTelegramStatus),
};

// Default link-status: unlinked with no installation. Tests that need the
// linked (telegramUserId) or unlinked-with-installation variants should
// override this handler via server.use(mockApi(zeroIntegrationsTelegramContract.getLinkStatus, ...)).
let mockLinkStatus: TelegramLinkStatusResponse = { linked: false };

export function resetMockTelegramIntegration(): void {
  mockTelegramList = { bots: structuredClone(defaultTelegramBots) };
  mockTelegramStatuses = {
    [defaultTelegramStatus.id]: structuredClone(defaultTelegramStatus),
  };
  mockLinkStatus = { linked: false };
}

export const apiIntegrationsTelegramHandlers = [
  mockApi(zeroIntegrationsTelegramContract.list, ({ respond }) => {
    return respond(200, mockTelegramList);
  }),

  mockApi(zeroIntegrationsTelegramContract.getBot, ({ params, respond }) => {
    const status = mockTelegramStatuses[params.botId];
    if (!status) {
      return respond(404, {
        error: { message: "Telegram bot not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, status);
  }),

  mockApi(
    zeroIntegrationsTelegramContract.updateBot,
    ({ params, body, respond }) => {
      const status = mockTelegramStatuses[params.botId];
      if (!status) {
        return respond(404, {
          error: { message: "Telegram bot not found", code: "NOT_FOUND" },
        });
      }
      status.agent = { id: body.defaultAgentId, name: "default-agent" };
      mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
        return bot.id === status.id ? { ...bot, agent: status.agent } : bot;
      });
      return respond(200, status);
    },
  ),

  mockApi(
    zeroIntegrationsTelegramContract.disconnect,
    ({ params, respond }) => {
      delete mockTelegramStatuses[params.botId];
      mockTelegramList.bots = mockTelegramList.bots.filter((bot) => {
        return bot.id !== params.botId;
      });
      return respond(204);
    },
  ),

  mockApi(zeroIntegrationsTelegramContract.getLinkStatus, ({ respond }) => {
    return respond(200, mockLinkStatus);
  }),

  mockApi(zeroIntegrationsTelegramContract.register, ({ respond }) => {
    const status: TelegramBotStatus = {
      id: "bot_registered",
      username: "registered_bot",
      agent: { id: "compose_1", name: "default-agent" },
      isOwner: true,
      isConnected: false,
      domainConfigured: false,
      environment: {
        requiredSecrets: ["ANTHROPIC_API_KEY"],
        requiredVars: [],
        missingSecrets: [],
        missingVars: [],
      },
    };
    mockTelegramStatuses[status.id] = structuredClone(status);
    mockTelegramList.bots = [...mockTelegramList.bots, status];
    return respond(201, status);
  }),
];
