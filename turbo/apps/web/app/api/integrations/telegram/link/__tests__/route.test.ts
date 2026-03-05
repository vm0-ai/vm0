import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createTestTelegramInstallation } from "../../../../../../src/__tests__/api-test-helpers";
import { PENDING_TELEGRAM_USER_ID } from "../../../../../../src/lib/telegram/handlers/shared";
import { telegramUserLinkExists } from "../../../../../../src/lib/telegram/__tests__/helpers";

const context = testContext();

function linkRequest(
  method: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>,
) {
  const url = new URL("http://localhost:3000/api/integrations/telegram/link");
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
  }
  return new Request(url.toString(), {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

describe("/api/integrations/telegram/link", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns linked: false when user has no link", async () => {
      await context.setupUser();

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(false);
    });

    it("returns linked: true with telegramUserId when linked", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(true);
      expect(data.telegramUserId).toBeDefined();
    });

    it("returns installation info when botId matches an existing bot", async () => {
      await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
      });

      const response = await GET(
        linkRequest("GET", undefined, { botId: telegramBotId }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(false);
      expect(data.installation).toEqual({
        id: installationId,
        botUsername: `bot_${telegramBotId}`,
      });
    });

    it("returns linked: false without installation for unknown botId", async () => {
      await context.setupUser();

      const response = await GET(
        linkRequest("GET", undefined, { botId: "nonexistent-bot-id" }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(false);
      expect(data.installation).toBeUndefined();
    });
  });

  describe("POST", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await POST(
        linkRequest("POST", { installationId: "some-id" }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when installationId is missing", async () => {
      await context.setupUser();

      const response = await POST(linkRequest("POST", {}));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 404 when installation does not exist", async () => {
      await context.setupUser();

      const response = await POST(
        linkRequest("POST", {
          installationId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("creates a pending user link and returns bot info", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        adminUserId: user.userId,
        telegramBotId,
      });

      const response = await POST(linkRequest("POST", { installationId }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
      expect(data.botLink).toContain("https://t.me/");

      // Verify pending user link was created
      const exists = await telegramUserLinkExists(
        installationId,
        PENDING_TELEGRAM_USER_ID,
      );
      expect(exists).toBe(true);
    });
  });
});
