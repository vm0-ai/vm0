import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse, http as mswHttp } from "msw";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { DELETE, GET, PATCH } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  createTestAgentSession,
  createTelegramInstallationForCompose,
  createTelegramThreadSession,
  createTestTelegramInstallation,
  countTestTelegramMessages,
  findTestTelegramUserAgentPreference,
  insertTelegramMessage,
  insertTestTelegramUserLink,
  seedTestTelegramUserAgentPreference,
  telegramThreadSessionExists,
  telegramUserLinkExists,
} from "../../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";

const context = testContext();

function botRequest(method: string, body?: Record<string, unknown>) {
  return new Request(
    "http://localhost:3000/api/integrations/telegram/bot_123",
    {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
}

function routeParams(botId: string) {
  return { params: Promise.resolve({ botId }) };
}

function telegramDeleteWebhook() {
  return http.post(/api\.telegram\.org\/bot.*\/deleteWebhook/, () => {
    return HttpResponse.json({ ok: true, result: true });
  });
}

function telegramDeleteWebhookFailure() {
  return http.post(/api\.telegram\.org\/bot.*\/deleteWebhook/, () => {
    return HttpResponse.json(
      { ok: false, description: "Telegram unavailable" },
      { status: 500 },
    );
  });
}

function telegramOauthHead() {
  return mswHttp.head("https://oauth.telegram.org/auth", () => {
    return new HttpResponse(null, {
      headers: { "content-length": "0" },
    });
  });
}

describe("/api/integrations/telegram/[botId]", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(telegramOauthHead());
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await GET(botRequest("GET"), routeParams("bot_123"));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 for an unknown bot", async () => {
      await context.setupUser();

      const response = await GET(botRequest("GET"), routeParams("missing"));
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("returns full status for an owned bot", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });

      const response = await GET(botRequest("GET"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual(
        expect.objectContaining({
          id: botId,
          username: `bot_${botId}`,
          avatarUrl: expect.stringContaining(
            `http://localhost:3000/api/integrations/telegram/${encodeURIComponent(
              botId,
            )}/avatar?exp=`,
          ),
          isOwner: true,
          isConnected: false,
          domainConfigured: false,
          environment: expect.objectContaining({
            requiredSecrets: expect.any(Array),
            requiredVars: expect.any(Array),
          }),
        }),
      );
      expect(data.agent).toEqual(
        expect.objectContaining({ id: expect.any(String) }),
      );
    });

    it("returns full status for a linked non-owner", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        vm0UserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });

      const response = await GET(botRequest("GET"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(botId);
      expect(data.isOwner).toBe(false);
      expect(data.isConnected).toBe(true);
    });

    it("returns full status for an unlinked org member", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
      });

      const response = await GET(botRequest("GET"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(botId);
      expect(data.isOwner).toBe(false);
      expect(data.isConnected).toBe(false);
    });

    it("returns 404 for a bot in another org", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
      });

      const response = await GET(botRequest("GET"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("returns full status for a bot the user neither owns nor linked", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });

      const response = await GET(botRequest("GET"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(botId);
      expect(data.isOwner).toBe(false);
      expect(data.isConnected).toBe(false);
    });

    it("returns the official bot status", async () => {
      await context.setupUser();

      const response = await GET(
        botRequest("GET"),
        routeParams(OFFICIAL_TELEGRAM_BOT_ID),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual(
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          isOwner: false,
          isConnected: false,
          official: expect.objectContaining({
            configured: false,
            usesDefaultAgent: true,
          }),
        }),
      );
    });
  });

  describe("PATCH", () => {
    it("returns 400 when defaultAgentId is missing", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });

      const response = await PATCH(botRequest("PATCH", {}), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 403 for a non-admin non-owner", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const { composeId } = await createTestCompose(uniqueId("agent"));
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
      });

      const response = await PATCH(
        botRequest("PATCH", { defaultAgentId: composeId }),
        routeParams(botId),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("updates the default agent for an org admin", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });
      const { composeId, name } = await createTestCompose(uniqueId("agent"));

      const response = await PATCH(
        botRequest("PATCH", { defaultAgentId: composeId }),
        routeParams(botId),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.agent).toEqual({ id: composeId, name });
      expect(data.id).toBe(botId);
      expect(data.isOwner).toBe(false);
    });

    it("updates the default agent for the owner", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const { composeId, name } = await createTestCompose(uniqueId("agent"));

      const response = await PATCH(
        botRequest("PATCH", { defaultAgentId: composeId }),
        routeParams(botId),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.agent).toEqual({ id: composeId, name });
      expect(data.id).toBe(botId);
    });

    it("returns 403 when defaultAgentId belongs to another org", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const otherOrgCompose = await context.createAgentCompose(user.userId, {
        name: uniqueId("other-agent"),
      });

      const response = await PATCH(
        botRequest("PATCH", { defaultAgentId: otherOrgCompose.id }),
        routeParams(botId),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("does not retarget a bot when the owner switches active org", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const otherOrgCompose = await context.createAgentCompose(user.userId, {
        name: uniqueId("other-agent"),
      });
      mockClerk({ userId: user.userId, orgId: otherOrgCompose.orgId });

      const response = await PATCH(
        botRequest("PATCH", { defaultAgentId: otherOrgCompose.id }),
        routeParams(botId),
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("updates the official bot agent preference for the current user and org", async () => {
      const user = await context.setupUser();
      const { composeId, name } = await createTestCompose(uniqueId("agent"));

      const response = await PATCH(
        botRequest("PATCH", { selectedAgentId: composeId }),
        routeParams(OFFICIAL_TELEGRAM_BOT_ID),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.agent).toEqual({ id: composeId, name });
      expect(data.official.usesDefaultAgent).toBe(false);

      const preference = await findTestTelegramUserAgentPreference({
        vm0UserId: user.userId,
        orgId: user.orgId,
      });
      expect(preference?.selectedComposeId).toBe(composeId);
    });

    it("clears the official bot agent preference when selectedAgentId is null", async () => {
      const user = await context.setupUser();
      const { composeId } = await createTestCompose(uniqueId("agent"));
      await seedTestTelegramUserAgentPreference({
        vm0UserId: user.userId,
        orgId: user.orgId,
        selectedComposeId: composeId,
      });

      const response = await PATCH(
        botRequest("PATCH", { selectedAgentId: null }),
        routeParams(OFFICIAL_TELEGRAM_BOT_ID),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.official.usesDefaultAgent).toBe(true);

      const preference = await findTestTelegramUserAgentPreference({
        vm0UserId: user.userId,
        orgId: user.orgId,
      });
      expect(preference?.selectedComposeId).toBeNull();
    });
  });

  describe("DELETE", () => {
    it("returns 403 for a non-admin non-owner", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
      });

      const response = await DELETE(botRequest("DELETE"), routeParams(botId));
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("deletes installation for an org admin", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: "other-owner",
        telegramBotId: botId,
        orgId: user.orgId,
      });
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });
      const deleteHandler = telegramDeleteWebhook();
      server.use(deleteHandler.handler);

      const response = await DELETE(botRequest("DELETE"), routeParams(botId));

      expect(response.status).toBe(204);
      expect(deleteHandler.mocked).toHaveBeenCalledTimes(1);

      const getResponse = await GET(botRequest("GET"), routeParams(botId));
      expect(getResponse.status).toBe(404);
    });

    it("deletes installation and removes webhook for the owner", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const deleteHandler = telegramDeleteWebhook();
      server.use(deleteHandler.handler);

      const response = await DELETE(botRequest("DELETE"), routeParams(botId));

      expect(response.status).toBe(204);
      expect(deleteHandler.mocked).toHaveBeenCalledTimes(1);

      const getResponse = await GET(botRequest("GET"), routeParams(botId));
      expect(getResponse.status).toBe(404);
    });

    it("deletes installation even when webhook removal fails", async () => {
      const user = await context.setupUser();
      const botId = uniqueId("bot");
      await createTestTelegramInstallation({
        ownerUserId: user.userId,
        telegramBotId: botId,
        orgId: user.orgId,
      });
      const deleteHandler = telegramDeleteWebhookFailure();
      server.use(deleteHandler.handler);

      const response = await DELETE(botRequest("DELETE"), routeParams(botId));

      expect(response.status).toBe(204);
      expect(deleteHandler.mocked).toHaveBeenCalledTimes(1);

      const getResponse = await GET(botRequest("GET"), routeParams(botId));
      expect(getResponse.status).toBe(404);
    });

    it("cascades links, messages, and thread sessions for the deleted bot", async () => {
      const user = await context.setupUser();
      const { composeId } = await createTestCompose(uniqueId("agent"));
      const botId = await createTelegramInstallationForCompose(
        composeId,
        user.userId,
        "cascade-test-token",
      );
      const userLink = await insertTestTelegramUserLink({
        installationId: botId,
        telegramUserId: "99077",
        vm0UserId: user.userId,
      });
      await insertTelegramMessage({
        installationId: botId,
        chatId: "77001",
        messageId: "88001",
        fromUserId: "99077",
        text: "before delete",
      });
      const agentSession = await createTestAgentSession(user.userId, composeId);
      await createTelegramThreadSession({
        telegramUserLinkId: userLink.id,
        chatId: "77001",
        rootMessageId: "dm",
        agentSessionId: agentSession.id,
      });
      const deleteHandler = telegramDeleteWebhook();
      server.use(deleteHandler.handler);

      const response = await DELETE(botRequest("DELETE"), routeParams(botId));

      expect(response.status).toBe(204);
      await expect(telegramUserLinkExists(botId, "99077")).resolves.toBe(false);
      await expect(countTestTelegramMessages(botId)).resolves.toBe(0);
      await expect(
        telegramThreadSessionExists({
          telegramUserLinkId: userLink.id,
          chatId: "77001",
          rootMessageId: "dm",
        }),
      ).resolves.toBe(false);
    });
  });
});
