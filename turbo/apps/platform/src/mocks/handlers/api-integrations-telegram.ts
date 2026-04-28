import {
  zeroIntegrationsTelegramContract,
  type TelegramBot,
  type TelegramBotStatus,
  type TelegramLinkStatusResponse,
  type TelegramListResponse,
  type TelegramSetupStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { mockApi } from "../msw-contract.ts";

const defaultTelegramBots: TelegramBot[] = [
  {
    id: "bot_123",
    username: "test_bot",
    avatarUrl: null,
    agent: { id: "compose_1", name: "default-agent" },
    isOwner: true,
    isConnected: true,
    tokenStatus: "valid",
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
let mockTelegramSetupStatus: TelegramSetupStatus = {
  id: "bot_registered",
  username: "registered_bot",
  domainConfigured: false,
  privacyDisabled: false,
};

// Default link-status: unlinked with no installation. Tests that need the
// linked (telegramUserId) or unlinked-with-installation variants should
// override this handler via server.use(mockApi(zeroIntegrationsTelegramContract.getLinkStatus, ...)).
let mockLinkStatus: TelegramLinkStatusResponse = { linked: false };

function statusToBot(status: TelegramBotStatus): TelegramBot {
  return {
    id: status.id,
    username: status.username,
    avatarUrl: status.avatarUrl,
    agent: status.agent,
    isOwner: status.isOwner,
    isConnected: status.isConnected,
    tokenStatus: status.tokenStatus,
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

function updateMockBotConnection(botId: string, connected: boolean): void {
  const status = mockTelegramStatuses[botId];
  if (!status) {
    return;
  }
  mockTelegramStatuses[botId] = { ...status, isConnected: connected };
  mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
    return bot.id === botId ? { ...bot, isConnected: connected } : bot;
  });
}

export function resetMockTelegramIntegration(): void {
  mockRegisterCounter = 0;
  setMockTelegramStatuses([defaultTelegramStatus]);
  mockTelegramSetupStatus = {
    id: "bot_registered",
    username: "registered_bot",
    domainConfigured: false,
    privacyDisabled: false,
  };
  mockLinkStatus = { linked: false };
}

export function setMockTelegramIntegration(input: {
  statuses?: TelegramBotStatus[];
  linkStatus?: TelegramLinkStatusResponse;
  setupStatus?: TelegramSetupStatus;
}): void {
  if (input.statuses) {
    setMockTelegramStatuses(input.statuses);
  }
  if (input.linkStatus) {
    mockLinkStatus = structuredClone(input.linkStatus);
  }
  if (input.setupStatus) {
    mockTelegramSetupStatus = structuredClone(input.setupStatus);
  }
}

export function getMockTelegramIntegration(): {
  list: TelegramListResponse;
  statuses: Record<string, TelegramBotStatus>;
  linkStatus: TelegramLinkStatusResponse;
  setupStatus: TelegramSetupStatus;
} {
  return {
    list: structuredClone(mockTelegramList),
    statuses: structuredClone(mockTelegramStatuses),
    linkStatus: structuredClone(mockLinkStatus),
    setupStatus: structuredClone(mockTelegramSetupStatus),
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
    zeroIntegrationsTelegramContract.getLinkStatus,
    ({ query, respond }) => {
      if (query.botId) {
        const status = mockTelegramStatuses[query.botId];
        if (status?.isConnected) {
          return respond(200, {
            linked: true,
            telegramUserId: mockLinkStatus.linked
              ? mockLinkStatus.telegramUserId
              : "99002",
            botUsername: status.username ?? undefined,
          });
        }
        if (status) {
          return respond(200, {
            linked: false,
            installation: {
              id: status.id,
              botUsername: status.username ?? "telegram_bot",
              domainConfigured: status.domainConfigured,
            },
          });
        }
      }

      if (mockLinkStatus.linked) {
        return respond(200, {
          ...mockLinkStatus,
          botUsername:
            Object.values(mockTelegramStatuses).find((status) => {
              return status.isConnected;
            })?.username ?? undefined,
        });
      }

      return respond(200, mockLinkStatus);
    },
  ),

  mockApi(zeroIntegrationsTelegramContract.link, ({ body, respond }) => {
    const status = mockTelegramStatuses[body.telegramBotId];
    if (!status) {
      return respond(404, {
        error: { message: "Installation not found", code: "NOT_FOUND" },
      });
    }
    const telegramUserId =
      body.connectSignature?.telegramUserId ?? String(body.telegramAuth?.id);
    updateMockBotConnection(body.telegramBotId, true);
    mockLinkStatus = { linked: true, telegramUserId };
    return respond(200, {
      botUsername: status.username ?? "telegram_bot",
      telegramUserId,
    });
  }),

  mockApi(zeroIntegrationsTelegramContract.unlink, ({ query, respond }) => {
    if (query.botId) {
      updateMockBotConnection(query.botId, false);
    } else {
      for (const botId of Object.keys(mockTelegramStatuses)) {
        updateMockBotConnection(botId, false);
      }
    }
    mockLinkStatus = { linked: false };
    return respond(204);
  }),

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

  mockApi(zeroIntegrationsTelegramContract.setupStatus, ({ respond }) => {
    return respond(200, mockTelegramSetupStatus);
  }),

  mockApi(zeroIntegrationsTelegramContract.register, ({ body, respond }) => {
    if (body.reinstallBotId) {
      const existing = mockTelegramStatuses[body.reinstallBotId];
      if (!existing) {
        return respond(404, {
          error: { message: "Telegram bot not found", code: "NOT_FOUND" },
        });
      }
      const status: TelegramBotStatus = {
        ...existing,
        tokenStatus: "valid",
        avatarUrl:
          existing.avatarUrl ??
          `/api/integrations/telegram/${encodeURIComponent(existing.id)}/avatar`,
      };
      mockTelegramStatuses[status.id] = structuredClone(status);
      mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
        return bot.id === status.id
          ? structuredClone(statusToBot(status))
          : bot;
      });
      return respond(200, status);
    }

    mockRegisterCounter += 1;
    const id =
      mockRegisterCounter === 1
        ? mockTelegramSetupStatus.id
        : `bot_registered_${mockRegisterCounter}`;
    const agentId = body.defaultAgentId ?? "compose_1";
    const status: TelegramBotStatus = {
      id,
      username:
        mockRegisterCounter === 1
          ? mockTelegramSetupStatus.username
          : `registered_bot_${mockRegisterCounter}`,
      agent: { id: agentId, name: "default-agent" },
      avatarUrl: `/api/integrations/telegram/${encodeURIComponent(id)}/avatar`,
      isOwner: true,
      isConnected: false,
      tokenStatus: "valid",
      domainConfigured: mockTelegramSetupStatus.domainConfigured,
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
