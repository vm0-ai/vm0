import { createHmac, createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse, http as mswHttp } from "msw";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { DELETE, GET, POST } from "../route";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import {
  createTestTelegramInstallation,
  findTestOfficialTelegramUserLink,
  findTestOfficialTelegramUserLinksByVm0UserId,
  findTestTelegramUserLinksByVm0UserId,
  insertTestOfficialTelegramUserLink,
  insertTestTelegramUserLink,
  signTestConnectParams,
} from "../../../../../../src/__tests__/api-test-helpers";
import { signConnectParams } from "../../../../../../src/lib/zero/telegram/connect-token";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { reloadEnv } from "../../../../../../src/env";

const TEST_BOT_TOKEN = "test-bot-token";
const OFFICIAL_BOT_TOKEN = "777000:official-token";
const OFFICIAL_BOT_USERNAME = "zero_vm0_bot";

/**
 * Build valid Telegram Login Widget auth data signed with the test bot token.
 */
function makeTelegramAuth(
  telegramUserId: number,
  username?: string,
  botToken = TEST_BOT_TOKEN,
) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields: Record<string, string | number> = {
    auth_date: authDate,
    id: telegramUserId,
    first_name: "Test",
  };
  if (username) fields.username = username;

  const checkString = Object.entries(fields)
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return { ...fields, hash };
}

const context = testContext();

function telegramOauthHead(contentLength: string, expectedOrigin?: string) {
  return mswHttp.head("https://oauth.telegram.org/auth", ({ request }) => {
    const url = new URL(request.url);
    if (expectedOrigin) {
      expect(url.searchParams.get("origin")).toBe(expectedOrigin);
    }
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

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

function setupOfficialTelegramEnv() {
  vi.stubEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  vi.stubEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  vi.stubEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", "official-webhook-secret");
  reloadEnv();
}

describe("/api/integrations/telegram/link", () => {
  beforeEach(() => {
    context.setupMocks();
    mockAblyPublish.mockClear();
    server.use(telegramOauthHead("0"));
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
      const telegramBotId = await createTestTelegramInstallation({
        ownerUserId: user.userId,
        vm0UserId: user.userId,
        orgId: user.orgId,
      });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(true);
      expect(data.telegramUserId).toBeDefined();
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
    });

    it("scopes linked status to the requested botId", async () => {
      const user = await context.setupUser();
      const linkedBotId = uniqueId("bot");
      const unlinkedBotId = uniqueId("bot");
      await createTestTelegramInstallation({
        telegramBotId: linkedBotId,
        ownerUserId: user.userId,
        vm0UserId: user.userId,
        orgId: user.orgId,
      });
      await createTestTelegramInstallation({
        telegramBotId: unlinkedBotId,
        ownerUserId: user.userId,
        orgId: user.orgId,
      });

      const linkedResponse = await GET(
        linkRequest("GET", undefined, { botId: linkedBotId }),
      );
      const linkedData = await linkedResponse.json();

      expect(linkedResponse.status).toBe(200);
      expect(linkedData.linked).toBe(true);
      expect(linkedData.botUsername).toBe(`bot_${linkedBotId}`);

      const unlinkedResponse = await GET(
        linkRequest("GET", undefined, { botId: unlinkedBotId }),
      );
      const unlinkedData = await unlinkedResponse.json();

      expect(unlinkedResponse.status).toBe(200);
      expect(unlinkedData.linked).toBe(false);
      expect(unlinkedData.installation).toEqual({
        id: unlinkedBotId,
        botUsername: `bot_${unlinkedBotId}`,
        loginBotId: unlinkedBotId,
        domainConfigured: false,
      });
    });

    it("returns installation info when botId matches an existing bot", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      server.use(telegramOauthHead("2048", "https://app.example.com"));

      const response = await GET(
        linkRequest("GET", undefined, {
          botId: telegramBotId,
          origin: "https://app.example.com/some/path",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(false);
      expect(data.installation).toEqual({
        id: installationId,
        botUsername: `bot_${telegramBotId}`,
        loginBotId: installationId,
        domainConfigured: true,
      });
    });

    it("returns official bot link status with the login bot id", async () => {
      setupOfficialTelegramEnv();
      await context.setupUser();

      const response = await GET(
        linkRequest("GET", undefined, {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          origin: "https://app.example.com/settings/telegram",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({
        linked: false,
        installation: {
          id: OFFICIAL_TELEGRAM_BOT_ID,
          botUsername: OFFICIAL_BOT_USERNAME,
          loginBotId: "777000",
          domainConfigured: false,
        },
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
      expect(mockAblyPublish).toHaveBeenCalledWith("telegram:changed", null);

      // Verify link is gone
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(false);
    });

    it("deletes only the requested bot link when botId is provided", async () => {
      const user = await context.setupUser();
      const firstBotId = await createTestTelegramInstallation({
        ownerUserId: user.userId,
        orgId: user.orgId,
      });
      const secondBotId = await createTestTelegramInstallation({
        ownerUserId: user.userId,
        orgId: user.orgId,
      });
      await insertTestTelegramUserLink({
        installationId: firstBotId,
        telegramUserId: "99001",
        vm0UserId: user.userId,
      });
      await insertTestTelegramUserLink({
        installationId: secondBotId,
        telegramUserId: "99002",
        vm0UserId: user.userId,
      });

      const response = await DELETE(
        linkRequest("DELETE", undefined, { botId: firstBotId }),
      );
      expect(response.status).toBe(204);

      const remainingLinks = await findTestTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(
        remainingLinks.map((link) => {
          return link.installationId;
        }),
      ).toStrictEqual([secondBotId]);
    });

    it("deletes only the official link when botId=official", async () => {
      setupOfficialTelegramEnv();
      const user = await context.setupUser();
      await insertTestOfficialTelegramUserLink({
        telegramUserId: "99090",
        vm0UserId: user.userId,
        orgId: user.orgId,
      });

      const response = await DELETE(
        linkRequest("DELETE", undefined, {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
        }),
      );

      expect(response.status).toBe(204);
      const rows = await findTestOfficialTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(rows).toHaveLength(0);
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
      const telegramAuth = makeTelegramAuth(telegramUserId, "ada_tg");

      const response = await POST(
        linkRequest("POST", { telegramBotId: installationId, telegramAuth }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
      expect(data.telegramUserId).toBe(String(telegramUserId));
      expect(mockAblyPublish).toHaveBeenCalledWith("telegram:changed", null);

      // Verify link was created
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(true);
      const userLinks = await findTestTelegramUserLinksByVm0UserId(user.userId);
      expect(userLinks[0]?.telegramUsername).toBe("ada_tg");
      expect(userLinks[0]?.telegramDisplayName).toBe("Test");
    });

    it("links the official bot account via telegramAuth", async () => {
      setupOfficialTelegramEnv();
      const user = await context.setupUser();
      const telegramUserId = Number(uniqueNumericId());
      const telegramAuth = makeTelegramAuth(
        telegramUserId,
        "official_tg",
        OFFICIAL_BOT_TOKEN,
      );

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth,
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({
        botUsername: OFFICIAL_BOT_USERNAME,
        telegramUserId: String(telegramUserId),
      });

      const officialLink = await findTestOfficialTelegramUserLink({
        telegramUserId: String(telegramUserId),
        orgId: user.orgId,
      });

      expect(officialLink?.vm0UserId).toBe(user.userId);
      expect(officialLink?.telegramUsername).toBe("official_tg");
      expect(officialLink?.telegramDisplayName).toBe("Test");
    });

    it("requires disconnect before moving an official Telegram user to another org", async () => {
      setupOfficialTelegramEnv();
      await context.setupUser();
      const otherOrgId = uniqueId("org");
      const telegramUserId = Number(uniqueNumericId());
      await insertTestOfficialTelegramUserLink({
        telegramUserId: String(telegramUserId),
        vm0UserId: uniqueId("other-user"),
        orgId: otherOrgId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: makeTelegramAuth(
            telegramUserId,
            "official_tg",
            OFFICIAL_BOT_TOKEN,
          ),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");
      expect(data.error.message).toContain("Disconnect it before connecting");
    });

    it("keeps an existing Telegram user link from being reassigned within the same bot", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      const otherVm0UserId = uniqueId("other-user");
      const telegramUserId = 99101;
      await insertTestTelegramUserLink({
        installationId,
        telegramUserId: String(telegramUserId),
        vm0UserId: otherVm0UserId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          telegramAuth: makeTelegramAuth(telegramUserId),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");

      const currentUserLinks = await findTestTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(
        currentUserLinks.some((link) => {
          return link.installationId === installationId;
        }),
      ).toBe(false);

      const otherUserLinks =
        await findTestTelegramUserLinksByVm0UserId(otherVm0UserId);
      expect(otherUserLinks).toHaveLength(1);
      expect(otherUserLinks[0]?.telegramUserId).toBe(String(telegramUserId));
    });

    it("keeps an existing VM0 user link from being replaced within the same bot", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      await insertTestTelegramUserLink({
        installationId,
        telegramUserId: "99102",
        vm0UserId: user.userId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          telegramAuth: makeTelegramAuth(99103),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");

      const currentUserLinks = await findTestTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(currentUserLinks).toHaveLength(1);
      expect(currentUserLinks[0]?.telegramUserId).toBe("99102");
    });

    it("allows the same Telegram user to connect to a different VM0 user in a different bot", async () => {
      const user = await context.setupUser();
      const firstBotId = uniqueId("bot");
      const secondBotId = uniqueId("bot");
      const firstInstallationId = await createTestTelegramInstallation({
        telegramBotId: firstBotId,
        orgId: user.orgId,
      });
      const secondInstallationId = await createTestTelegramInstallation({
        telegramBotId: secondBotId,
        orgId: user.orgId,
      });
      const otherVm0UserId = uniqueId("other-user");
      const telegramUserId = 99104;
      await insertTestTelegramUserLink({
        installationId: firstInstallationId,
        telegramUserId: String(telegramUserId),
        vm0UserId: otherVm0UserId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: secondInstallationId,
          telegramAuth: makeTelegramAuth(telegramUserId),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.telegramUserId).toBe(String(telegramUserId));

      const currentUserLinks = await findTestTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(
        currentUserLinks.some((link) => {
          return link.installationId === secondInstallationId;
        }),
      ).toBe(true);
    });

    it("treats reconnecting the same Telegram user to the same VM0 user as idempotent", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      const telegramUserId = 99105;
      await insertTestTelegramUserLink({
        installationId,
        telegramUserId: String(telegramUserId),
        vm0UserId: user.userId,
      });

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          telegramAuth: makeTelegramAuth(telegramUserId),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.telegramUserId).toBe(String(telegramUserId));

      const currentUserLinks = await findTestTelegramUserLinksByVm0UserId(
        user.userId,
      );
      expect(currentUserLinks).toHaveLength(1);
    });

    it("links account via connectSignature with valid signed params", async () => {
      const user = await context.setupUser();
      const telegramBotId = uniqueId("bot");
      const installationId = await createTestTelegramInstallation({
        telegramBotId,
        orgId: user.orgId,
      });
      const sentMessages: Array<{ chat_id: string; text: string }> = [];
      server.use(
        http.post(
          `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`,
          async ({ request }) => {
            sentMessages.push(
              (await request.json()) as { chat_id: string; text: string },
            );
            return HttpResponse.json({
              ok: true,
              result: { message_id: 1, chat: { id: 99002 } },
            });
          },
        ).handler,
      );

      const telegramUserId = "99002";
      const { sig, ts } = signTestConnectParams(
        installationId,
        telegramUserId,
        TEST_BOT_TOKEN,
        "connect_tg",
        "Connect User",
      );

      const response = await POST(
        linkRequest("POST", {
          telegramBotId: installationId,
          connectSignature: {
            telegramUserId,
            telegramUsername: "connect_tg",
            telegramDisplayName: "Connect User",
            timestamp: ts,
            signature: sig,
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBe(`bot_${telegramBotId}`);
      expect(data.telegramUserId).toBe(telegramUserId);
      expect(mockAblyPublish).toHaveBeenCalledWith("telegram:changed", null);

      // Verify link was created
      const getResponse = await GET(linkRequest("GET"));
      const getData = await getResponse.json();
      expect(getData.linked).toBe(true);
      const userLinks = await findTestTelegramUserLinksByVm0UserId(user.userId);
      expect(userLinks[0]?.telegramUsername).toBe("connect_tg");
      expect(userLinks[0]?.telegramDisplayName).toBe("Connect User");

      await vi.waitFor(() => {
        expect(sentMessages).toHaveLength(1);
      });
      expect(sentMessages[0]?.text).toBe(
        "✅ Account linked.\nSend me a message to start chatting with your agent.",
      );
      expect(sentMessages[0]?.text).not.toContain(installationId);
      expect(sentMessages[0]?.text).not.toContain("is ready");
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
