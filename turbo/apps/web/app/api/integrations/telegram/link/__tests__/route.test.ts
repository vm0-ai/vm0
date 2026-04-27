import { createHmac, createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { DELETE, GET, POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestTelegramInstallation,
  signTestConnectParams,
} from "../../../../../../src/__tests__/api-test-helpers";
import { signConnectParams } from "../../../../../../src/lib/zero/telegram/connect-token";

const TEST_BOT_TOKEN = "test-bot-token";

/**
 * Build valid Telegram Login Widget auth data signed with the test bot token.
 */
function makeTelegramAuth(telegramUserId: number) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields: Record<string, string | number> = {
    auth_date: authDate,
    id: telegramUserId,
    first_name: "Test",
  };

  const checkString = Object.entries(fields)
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(TEST_BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return { ...fields, hash };
}

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
        ownerUserId: user.userId,
        vm0UserId: user.userId,
        orgId: user.orgId,
      });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(true);
      expect(data.telegramUserId).toBeDefined();
    });

    it("returns installation info when botId matches an existing bot", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
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

    it("returns 403 when botId belongs to another org", async () => {
      await context.setupUser();
      const telegramBotId = uniqueId("bot");
      await createTestTelegramInstallation({ telegramBotId });

      const response = await GET(
        linkRequest("GET", undefined, { botId: telegramBotId }),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
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

  describe("DELETE", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await DELETE(linkRequest("DELETE"));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no link", async () => {
      await context.setupUser();

      const response = await DELETE(linkRequest("DELETE"));
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes user link and returns 204", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        vm0UserId: user.userId,
        orgId: user.orgId,
      });

      const response = await DELETE(linkRequest("DELETE"));
      expect(response.status).toBe(204);

      // Verify link is gone
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(false);
    });
  });

  describe("POST", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await POST(
        linkRequest("POST", { telegramBotId: "some-id" }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when telegramBotId is missing", async () => {
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
          telegramBotId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("returns 400 without telegramAuth or connectSignature", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });

      const response = await POST(
        linkRequest("POST", { telegramBotId: installationId }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("links account via telegramAuth with valid login widget data", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });

      const telegramUserId = 99001;
      const telegramAuth = makeTelegramAuth(telegramUserId);

      const response = await POST(
        linkRequest("POST", { telegramBotId: installationId, telegramAuth }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
      expect(data.telegramUserId).toBe(String(telegramUserId));

      // Verify link was created
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(true);
    });

    it("links account via connectSignature with valid signed params", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });

      const telegramUserId = "99002";
      const { sig, ts } = signTestConnectParams(
        installationId,
        telegramUserId,
        TEST_BOT_TOKEN,
      );

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          connectSignature: { telegramUserId, timestamp: ts, signature: sig },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
      expect(data.telegramUserId).toBe(telegramUserId);

      // Verify link was created
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(true);
    });

    it("returns 403 when connecting a bot from another org", async () => {
      await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          telegramAuth: makeTelegramAuth(99004),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 400 for invalid telegramAuth hash", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          telegramAuth: {
            id: 12345,
            first_name: "Test",
            auth_date: Math.floor(Date.now() / 1000),
            hash: "invalid_hash",
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 400 for invalid connectSignature", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          connectSignature: {
            telegramUserId: "99003",
            timestamp: Math.floor(Date.now() / 1000),
            signature: "a".repeat(64),
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 400 for expired connectSignature", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      const telegramUserId = "99005";
      const timestamp = Math.floor(Date.now() / 1000) - 601;
      const signature = signConnectParams(
        installationId,
        telegramUserId,
        timestamp,
        TEST_BOT_TOKEN,
      );

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          connectSignature: {
            telegramUserId,
            timestamp,
            signature,
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid or expired connect link");
    });
  });
});
