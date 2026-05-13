import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestTelegramInstallation,
  insertTestOfficialTelegramUserLink,
  insertTestTelegramUserLink,
} from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();
const OFFICIAL_BOT_TOKEN = "777000:official-token";

function telegramRequest() {
  return new Request("http://localhost:3000/api/integrations/telegram");
}

function telegramGetMe(token: string, response: "valid" | "invalid") {
  return http.post(`https://api.telegram.org/bot${token}/getMe`, () => {
    if (response === "invalid") {
      return HttpResponse.json(
        { ok: false, description: "Unauthorized" },
        { status: 401 },
      );
    }

    return HttpResponse.json({
      ok: true,
      result: {
        id: 123,
        is_bot: true,
        first_name: "Bot",
        username: "test_bot",
      },
    });
  });
}

function setupOfficialTelegramEnv() {
  vi.stubEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  reloadEnv();
}

describe("/api/integrations/telegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns the official bot when the active org has no custom Telegram bots", async () => {
      await context.setupUser();

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          isOwner: false,
          isConnected: false,
        }),
      ]);
    });

    it("includes the official bot avatar URL when the official token is configured", async () => {
      setupOfficialTelegramEnv();
      await context.setupUser();

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          avatarUrl: expect.stringContaining(
            `http://localhost:3000/api/integrations/telegram/${OFFICIAL_TELEGRAM_BOT_ID}/avatar?exp=`,
          ),
        }),
      ]);
    });

    it("returns all bots in the active org", async () => {
      const user = await context.setupUser();
      const firstBotId = uniqueId("bot");
      const secondBotId = uniqueId("bot");

      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        vm0UserId: user.userId,
        telegramBotId: firstBotId,
        orgId: user.orgId,
      });
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: secondBotId,
        orgId: user.orgId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toHaveLength(3);
      expect(data.bots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: OFFICIAL_TELEGRAM_BOT_ID,
            kind: "official",
          }),
          expect.objectContaining({
            id: firstBotId,
            username: `bot_${firstBotId}`,
            avatarUrl: expect.stringContaining(
              `http://localhost:3000/api/integrations/telegram/${encodeURIComponent(
                firstBotId,
              )}/avatar?exp=`,
            ),
            isOwner: true,
            isConnected: true,
            agent: expect.objectContaining({ id: expect.any(String) }),
          }),
          expect.objectContaining({
            id: secondBotId,
            username: `bot_${secondBotId}`,
            avatarUrl: expect.stringContaining(
              `http://localhost:3000/api/integrations/telegram/${encodeURIComponent(
                secondBotId,
              )}/avatar?exp=`,
            ),
            isOwner: false,
            isConnected: false,
            agent: expect.objectContaining({ id: expect.any(String) }),
          }),
        ]),
      );
    });

    it("includes bots owned by other users in the active org", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: OFFICIAL_TELEGRAM_BOT_ID,
            kind: "official",
          }),
          expect.objectContaining({
            id: botId,
            isOwner: false,
            isConnected: false,
          }),
        ]),
      );
    });

    it("excludes owned bots from other orgs", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        vm0UserId: user.userId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
        }),
      ]);
    });

    it("marks org bots as connected when the user is linked but not the owner", async () => {
      const user = await context.setupUser();
      const botId = await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        orgId: user.orgId,
      });
      await insertTestTelegramUserLink({
        installationId: botId,
        telegramUserId: "tg-user-ada",
        telegramUsername: "ada_tg",
        telegramDisplayName: "Ada Lovelace",
        vm0UserId: user.userId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: OFFICIAL_TELEGRAM_BOT_ID,
            kind: "official",
          }),
          expect.objectContaining({
            id: botId,
            isOwner: false,
            isConnected: true,
            connectedUser: {
              telegramUserId: "tg-user-ada",
              telegramUsername: "ada_tg",
              telegramDisplayName: "Ada Lovelace",
            },
          }),
        ]),
      );
    });

    it("includes the connected official Telegram user profile", async () => {
      const user = await context.setupUser();

      await insertTestOfficialTelegramUserLink({
        orgId: user.orgId,
        vm0UserId: user.userId,
        telegramUserId: "official-user-ada",
        telegramUsername: "official_ada",
        telegramDisplayName: "Official Ada",
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          isConnected: true,
          connectedUser: {
            telegramUserId: "official-user-ada",
            telegramUsername: "official_ada",
            telegramDisplayName: "Official Ada",
          },
          official: expect.objectContaining({
            linkedTelegramUserId: "official-user-ada",
          }),
        }),
      ]);
    });

    it("marks a bot token invalid when Telegram rejects the stored token", async () => {
      const user = await context.setupUser();
      const invalidToken = telegramGetMe("test-bot-token", "invalid");
      server.use(invalidToken.handler);
      const botId = await createTestTelegramInstallation({
        ownerUserId: user.userId,
        orgId: user.orgId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: OFFICIAL_TELEGRAM_BOT_ID,
            kind: "official",
          }),
          expect.objectContaining({
            id: botId,
            tokenStatus: "invalid",
          }),
        ]),
      );
    });
  });
});
