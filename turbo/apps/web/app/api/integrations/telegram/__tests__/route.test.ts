import { describe, it, expect, beforeEach } from "vitest";
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

const context = testContext();

function telegramRequest() {
  return new Request("http://localhost:3000/api/integrations/telegram");
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

    it("returns an empty list when the user owns no Telegram bots", async () => {
      await context.setupUser();

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ bots: [] });
    });

    it("returns all bots owned by the user in the active org", async () => {
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
        ownerUserId: user.userId,
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
            isOwner: true,
            isConnected: true,
            agent: expect.objectContaining({ id: expect.any(String) }),
          }),
          expect.objectContaining({
            id: secondBotId,
            username: `bot_${secondBotId}`,
            isOwner: true,
            isConnected: false,
            agent: expect.objectContaining({ id: expect.any(String) }),
          }),
        ]),
      );
    });

    it("excludes bots owned by other users", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        vm0UserId: user.userId,
        orgId: user.orgId,
      });

      const response = await GET(telegramRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ bots: [] });
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

    it("excludes bots where the user is linked but not the owner", async () => {
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
      expect(data).toEqual({ bots: [] });
    });
  });
});
