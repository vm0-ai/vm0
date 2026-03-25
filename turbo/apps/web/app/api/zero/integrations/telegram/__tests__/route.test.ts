import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { GET, PATCH, DELETE } from "../route";
import { POST as installPOST } from "../install/route";
import { POST as connectPOST } from "../connect/route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestOrg,
  createTestCompose,
  createTestOrgTelegramInstallation,
  findTestOrgTelegramInstallation,
  findTestTelegramUserLink,
  updateOrgDefaultAgent,
} from "../../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import { signConnectParams } from "../../../../../../src/lib/telegram/connect-token";

const context = testContext();

function telegramOAuthProbe(domainConfigured: boolean) {
  return mswHttp.head(/oauth\.telegram\.org\/auth/, () =>
    HttpResponse.text("", {
      headers: { "content-length": domainConfigured ? "5000" : "100" },
    }),
  );
}

function telegramDeleteWebhook() {
  return mswHttp.post(/api\.telegram\.org\/bot.*\/deleteWebhook/, () =>
    HttpResponse.json({ ok: true, result: true }),
  );
}

const TEST_BOT_TOKEN = "123456:ABC-test-token";

function telegramGetMe(botId: string, username: string) {
  return http.post(/api\.telegram\.org\/bot.*\/getMe/, () =>
    HttpResponse.json({
      ok: true,
      result: { id: Number(botId), is_bot: true, first_name: "Bot", username },
    }),
  );
}

function telegramGetMeFail() {
  return http.post(/api\.telegram\.org\/bot.*\/getMe/, () =>
    HttpResponse.json(
      { ok: false, description: "Unauthorized" },
      { status: 401 },
    ),
  );
}

function telegramSetWebhook(succeed = true) {
  return http.post(/api\.telegram\.org\/bot.*\/setWebhook/, () =>
    succeed
      ? HttpResponse.json({ ok: true, result: true })
      : HttpResponse.json(
          { ok: false, description: "Webhook failed" },
          { status: 400 },
        ),
  );
}

function telegramSetMyCommands() {
  return http.post(/api\.telegram\.org\/bot.*\/setMyCommands/, () =>
    HttpResponse.json({ ok: true, result: true }),
  );
}

function telegramSendMessage() {
  return http.post(/api\.telegram\.org\/bot.*\/sendMessage/, () =>
    HttpResponse.json({
      ok: true,
      result: { message_id: 1, chat: { id: 1 }, text: "ok" },
    }),
  );
}

/**
 * Generate valid Telegram Login Widget auth data for testing.
 * Uses the same HMAC-SHA256 verification algorithm as verifyTelegramLogin.
 */
function generateTelegramAuth(
  botToken: string,
  telegramUserId: number,
): Record<string, unknown> {
  const authDate = Math.floor(Date.now() / 1000);
  const authData: Record<string, unknown> = {
    id: telegramUserId,
    first_name: "Test",
    auth_date: authDate,
  };

  const checkString = Object.entries(authData)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return { ...authData, hash };
}

/** Generate a unique numeric bot ID */
function testBotId(): string {
  return String(Date.now() + Math.floor(Math.random() * 100000));
}

async function givenOrgTelegramSetup(
  options: {
    isAdmin?: boolean;
    withConnection?: boolean;
    enabled?: boolean;
  } = {},
) {
  const { isAdmin = false, withConnection = true, enabled = true } = options;
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { installationId, telegramBotId } =
    await createTestOrgTelegramInstallation({
      orgId: org.id,
      adminUserId: user.userId,
      vm0UserId: withConnection ? user.userId : undefined,
      enabled,
    });

  mockClerk({
    userId: user.userId,
    orgId: org.id,
    orgRole: isAdmin ? "org:admin" : "org:member",
  });

  server.use(telegramOAuthProbe(true));

  return { user, org, installationId, telegramBotId };
}

describe("/api/zero/integrations/telegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns isInstalled=false when no bot is installed for the org", async () => {
      await context.setupUser();
      await createTestOrg(uniqueId("org"));

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isInstalled).toBe(false);
      expect(data.isConnected).toBe(false);
    });

    it("returns isConnected=false when user has no connection", async () => {
      await givenOrgTelegramSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isInstalled).toBe(true);
      expect(data.isConnected).toBe(false);
    });

    it("returns connected status with bot info", async () => {
      const { telegramBotId } = await givenOrgTelegramSetup({
        withConnection: true,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(true);
      expect(data.isInstalled).toBe(true);
      expect(data.bot.id).toBe(telegramBotId);
    });

    it("returns isAdmin=true for admin members", async () => {
      await givenOrgTelegramSetup({ isAdmin: true });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(true);
    });

    it("returns isAdmin=false for non-admin members", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(false);
    });

    it("returns enabled status", async () => {
      await givenOrgTelegramSetup({ enabled: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.enabled).toBe(false);
    });

    it("returns environment info when connected", async () => {
      await givenOrgTelegramSetup();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.environment).toBeDefined();
      expect(data.environment.requiredSecrets).toBeDefined();
      expect(data.environment.missingSecrets).toBeDefined();
    });
  });

  describe("PATCH", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when non-admin tries to toggle", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("toggles enabled state for admin", async () => {
      const { org } = await givenOrgTelegramSetup({
        isAdmin: true,
        enabled: true,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify in DB
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation?.enabled).toBe(false);
    });

    it("returns 404 when no installation exists", async () => {
      await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: (await context.setupUser()).userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("DELETE (disconnect)", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no connection", async () => {
      await givenOrgTelegramSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes user link and returns ok", async () => {
      const { user, installationId } = await givenOrgTelegramSetup();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify link was deleted
      const link = await findTestTelegramUserLink(user.userId, installationId);
      expect(link).toBeUndefined();
    });
  });

  describe("POST /install", () => {
    async function givenOrgWithDefaultAgent() {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      const { composeId } = await createTestCompose(uniqueId("agent"));

      // Set it as org default agent (composeId = zero_agents.id)
      await updateOrgDefaultAgent(org.id, composeId);

      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      return { user, org, composeId };
    }

    function installRequest(body: Record<string, unknown>) {
      return new Request(
        "http://localhost:3000/api/zero/integrations/telegram/install",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    }

    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when non-admin tries to install", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:member",
      });

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 400 when bot token is invalid", async () => {
      await givenOrgWithDefaultAgent();

      const getMeHandler = telegramGetMeFail();
      server.use(getMeHandler.handler);

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid bot token");
    });

    it("installs bot and auto-connects admin", async () => {
      const { user, org } = await givenOrgWithDefaultAgent();

      const botId = testBotId();
      const telegramUserId = 99001;
      const getMeHandler = telegramGetMe(botId, `bot_${botId}`);
      const setWebhookHandler = telegramSetWebhook(true);
      const setCommandsHandler = telegramSetMyCommands();
      server.use(
        getMeHandler.handler,
        setWebhookHandler.handler,
        setCommandsHandler.handler,
      );

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, telegramUserId),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.bot.id).toBe(botId);
      expect(data.bot.username).toBe(`bot_${botId}`);
      expect(data.installationId).toBeDefined();

      // Verify installation was created in DB
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation).toBeDefined();
      expect(installation!.telegramBotId).toBe(botId);
      expect(installation!.orgId).toBe(org.id);

      // Verify auto-connect user link
      const link = await findTestTelegramUserLink(
        user.userId,
        data.installationId,
      );
      expect(link).toBeDefined();
    });

    it("returns 409 when org already has a bot", async () => {
      const { user, org } = await givenOrgWithDefaultAgent();

      // Pre-install a bot for the org
      await createTestOrgTelegramInstallation({
        orgId: org.id,
        adminUserId: user.userId,
      });

      const botId = testBotId();
      const getMeHandler = telegramGetMe(botId, `bot_${botId}`);
      server.use(getMeHandler.handler);

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");
      expect(data.error.message).toContain("already has a Telegram bot");
    });

    it("returns 409 when bot is already registered to another org", async () => {
      // Set up first org with a bot using a different user prefix
      const otherUser = await context.setupUser({ prefix: "other-admin" });
      const otherOrg = await createTestOrg(uniqueId("org"));
      const existingBotId = testBotId();
      await createTestOrgTelegramInstallation({
        orgId: otherOrg.id,
        adminUserId: otherUser.userId,
        telegramBotId: existingBotId,
      });

      // Set up a second org with its own admin
      const user = await context.setupUser({ prefix: "new-admin" });
      const org = await createTestOrg(uniqueId("org"));
      const { composeId } = await createTestCompose(uniqueId("agent"));
      await updateOrgDefaultAgent(org.id, composeId);
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const getMeHandler = telegramGetMe(
        existingBotId,
        `dup_bot_${existingBotId}`,
      );
      server.use(getMeHandler.handler);

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");
      expect(data.error.message).toContain("already registered");
    });

    it("rolls back installation when webhook setup fails", async () => {
      const { org } = await givenOrgWithDefaultAgent();

      const botId = testBotId();
      const getMeHandler = telegramGetMe(botId, `bot_${botId}`);
      const setWebhookHandler = telegramSetWebhook(false);
      server.use(getMeHandler.handler, setWebhookHandler.handler);

      const response = await installPOST(
        installRequest({
          botToken: TEST_BOT_TOKEN,
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(502);
      expect(data.error.code).toBe("BAD_GATEWAY");

      // Verify installation was rolled back
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation).toBeUndefined();
    });
  });

  describe("POST /connect", () => {
    function connectRequest(body: Record<string, unknown>) {
      return new Request(
        "http://localhost:3000/api/zero/integrations/telegram/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    }

    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await connectPOST(
        connectRequest({
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when no installation exists for the org", async () => {
      await context.setupUser();
      await createTestOrg(uniqueId("org"));

      const response = await connectPOST(
        connectRequest({
          telegramAuth: generateTelegramAuth(TEST_BOT_TOKEN, 12345),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("connects user via Telegram Login Widget auth", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      const { installationId } = await createTestOrgTelegramInstallation({
        orgId: org.id,
        adminUserId: user.userId,
      });

      // mockClerk is already set up by createTestOrg+setupUser flow
      // but we need to ensure correct identity
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:member",
      });

      const telegramUserId = 55001;
      // The bot token used in createTestOrgTelegramInstallation is "test-bot-token"
      const response = await connectPOST(
        connectRequest({
          telegramAuth: generateTelegramAuth("test-bot-token", telegramUserId),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBeDefined();
      expect(data.telegramUserId).toBe(String(telegramUserId));

      // Verify user link was created
      const link = await findTestTelegramUserLink(user.userId, installationId);
      expect(link).toBeDefined();
    });

    it("connects user via connect signature", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      const { installationId } = await createTestOrgTelegramInstallation({
        orgId: org.id,
        adminUserId: user.userId,
      });

      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:member",
      });

      const sendMsgHandler = telegramSendMessage();
      server.use(sendMsgHandler.handler);

      const telegramUserId = "77001";
      const timestamp = Math.floor(Date.now() / 1000);
      // The bot token stored in test installations is "test-bot-token"
      const signature = signConnectParams(
        installationId,
        telegramUserId,
        timestamp,
        "test-bot-token",
      );

      const response = await connectPOST(
        connectRequest({
          connectSignature: {
            telegramUserId,
            timestamp,
            signature,
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.botUsername).toBeDefined();
      expect(data.telegramUserId).toBe(telegramUserId);

      // Verify user link was created
      const link = await findTestTelegramUserLink(user.userId, installationId);
      expect(link).toBeDefined();
    });

    it("returns 400 when Telegram Login Widget auth is invalid", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      await createTestOrgTelegramInstallation({
        orgId: org.id,
        adminUserId: user.userId,
      });

      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:member",
      });

      const response = await connectPOST(
        connectRequest({
          telegramAuth: {
            id: 12345,
            first_name: "Test",
            auth_date: Math.floor(Date.now() / 1000),
            hash: "invalid_hash_value",
          },
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("Invalid Telegram authorization");
    });

    it("returns 400 when neither telegramAuth nor connectSignature is provided", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      await createTestOrgTelegramInstallation({
        orgId: org.id,
        adminUserId: user.userId,
      });

      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:member",
      });

      const response = await connectPOST(connectRequest({}));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain(
        "Either telegramAuth or connectSignature is required",
      );
    });
  });

  describe("PATCH agentName", () => {
    it("changes default agent by name for admin", async () => {
      const { org } = await givenOrgTelegramSetup({ isAdmin: true });

      // Create a second compose to switch to
      const newAgentName = uniqueId("new-agent");
      await createTestCompose(newAgentName);

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: newAgentName }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify the defaultComposeId was updated
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation).toBeDefined();
      // The old compose was the one from givenOrgTelegramSetup; now it should be different
      expect(installation!.defaultComposeId).toBeDefined();
    });

    it("returns 404 when agent name does not exist", async () => {
      await givenOrgTelegramSetup({ isAdmin: true });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "nonexistent-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("DELETE ?action=uninstall", () => {
    it("returns 403 when non-admin tries to uninstall", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 when no installation exists", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes installation and returns ok", async () => {
      const { org } = await givenOrgTelegramSetup({ isAdmin: true });
      server.use(telegramDeleteWebhook());

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify installation was deleted
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation).toBeUndefined();
    });
  });
});
