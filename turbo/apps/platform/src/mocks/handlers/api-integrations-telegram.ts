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

let mockRegisterCounter = 0;
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

function statusToBot(status: TelegramBotStatus): TelegramBot {
  return {
    id: status.id,
    username: status.username,
    agent: status.agent,
    isOwner: status.isOwner,
    isConnected: status.isConnected,
  };
}

function setMockTelegramStatuses(statuses: TelegramBotStatus[]): void {
  mockTelegramStatuses = Object.fromEntries(
    statuses.map((status) => {
      return [status.id, structuredClone(status)];
    }),
  );
  mockTelegramList = {
    bots: statuses.map((status) => {
      return structuredClone(statusToBot(status));
    }),
  };
}

export function resetMockTelegramIntegration(): void {
  mockRegisterCounter = 0;
  setMockTelegramStatuses([defaultTelegramStatus]);
  mockLinkStatus = { linked: false };
}

export function setMockTelegramIntegration(input: {
  statuses?: TelegramBotStatus[];
  linkStatus?: TelegramLinkStatusResponse;
}): void {
  if (input.statuses) {
    setMockTelegramStatuses(input.statuses);
  }
  if (input.linkStatus) {
    mockLinkStatus = structuredClone(input.linkStatus);
  }
}

export function getMockTelegramIntegration(): {
  list: TelegramListResponse;
  statuses: Record<string, TelegramBotStatus>;
  linkStatus: TelegramLinkStatusResponse;
} {
  return {
    list: structuredClone(mockTelegramList),
    statuses: structuredClone(mockTelegramStatuses),
    linkStatus: structuredClone(mockLinkStatus),
  };
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
      const agent = { id: body.defaultAgentId, name: "default-agent" };
      mockTelegramStatuses[status.id] = { ...status, agent };
      mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
        return bot.id === status.id ? { ...bot, agent } : bot;
      });
      return respond(200, mockTelegramStatuses[status.id]!);
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

  mockApi(zeroIntegrationsTelegramContract.register, ({ body, respond }) => {
    mockRegisterCounter += 1;
    const id =
      mockRegisterCounter === 1
        ? "bot_registered"
        : `bot_registered_${mockRegisterCounter}`;
    const agentId = body.defaultAgentId ?? "compose_1";
    const status: TelegramBotStatus = {
      id,
      username:
        mockRegisterCounter === 1
          ? "registered_bot"
          : `registered_bot_${mockRegisterCounter}`,
      agent: { id: agentId, name: "default-agent" },
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
    mockTelegramList.bots = [
      ...mockTelegramList.bots,
      structuredClone(statusToBot(status)),
    ];
    return respond(201, status);
  }),
];
