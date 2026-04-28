import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestTelegramInstallation,
  insertTestTelegramUserLink,
} from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";

const context = testContext();

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

    it("returns an empty list when the active org has no Telegram bots", async () => {
      await context.setupUser();

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ bots: [] });
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
      expect(data.bots).toHaveLength(2);
      expect(data.bots).toEqual(
        expect.arrayContaining([
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
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: botId,
          isOwner: false,
          isConnected: false,
        }),
      ]);
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
      expect(data).toEqual({ bots: [] });
    });

    it("marks org bots as connected when the user is linked but not the owner", async () => {
      const user = await context.setupUser();
      const botId = await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        orgId: user.orgId,
      });
      await insertTestTelegramUserLink({
        installationId: botId,
        telegramUserId: uniqueId("tg-user"),
        vm0UserId: user.userId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: botId,
          isOwner: false,
          isConnected: true,
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
      expect(data.bots).toEqual([
        expect.objectContaining({
          id: botId,
          tokenStatus: "invalid",
        }),
      ]);
    });
  });
});
