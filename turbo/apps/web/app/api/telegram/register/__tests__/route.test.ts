import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse, http as mswHttp } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  getTestTelegramBotToken,
  updateOrgDefaultAgent,
} from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-test-token";
const NEW_BOT_TOKEN = "123456:ABC-new-token";

function telegramGetMe(
  botId: string,
  username: string,
  token = TEST_BOT_TOKEN,
) {
  return http.post(`https://api.telegram.org/bot${token}/getMe`, () => {
    return HttpResponse.json({
      ok: true,
      result: {
        id: Number(botId),
        is_bot: true,
        first_name: "Bot",
        username,
      },
    });
  });
}

function telegramGetMeFail(token = TEST_BOT_TOKEN) {
  return http.post(`https://api.telegram.org/bot${token}/getMe`, () => {
    return HttpResponse.json(
      { ok: false, description: "Unauthorized" },
      { status: 401 },
    );
  });
}

function telegramSetWebhook(succeed = true, token = TEST_BOT_TOKEN) {
  return http.post(`https://api.telegram.org/bot${token}/setWebhook`, () => {
    return succeed
      ? HttpResponse.json({ ok: true, result: true })
      : HttpResponse.json(
          { ok: false, description: "Webhook failed" },
          { status: 400 },
        );
  });
}

function telegramSetMyCommands(token = TEST_BOT_TOKEN) {
  return http.post(`https://api.telegram.org/bot${token}/setMyCommands`, () => {
    return HttpResponse.json({ ok: true, result: true });
  });
}

function telegramOauthHead() {
  return mswHttp.head("https://oauth.telegram.org/auth", () => {
    return new HttpResponse(null, {
      headers: { "content-length": "0" },
    });
  });
}

function registerRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/telegram/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Generate a unique numeric bot ID for test isolation */
function testBotId(): string {
  return String(Date.now() + Math.floor(Math.random() * 100000));
}

describe("POST /api/telegram/register", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(telegramOauthHead());
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(registerRequest({ botToken: TEST_BOT_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when botToken is missing", async () => {
    await context.setupUser();

    const response = await POST(registerRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when bot token is invalid", async () => {
    await context.setupUser();

    const handler = telegramGetMeFail();
    server.use(handler.handler);

    const response = await POST(registerRequest({ botToken: TEST_BOT_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid bot token");
  });

  it("creates installation and sets webhook on valid token", async () => {
    await context.setupUser();

    const botId = testBotId();
    const { composeId, name } = await createTestCompose(uniqueId("agent"));

    const getMeHandler = telegramGetMe(botId, `bot_${botId}`);
    const setWebhookHandler = telegramSetWebhook(true);
    const setCommandsHandler = telegramSetMyCommands();
    server.use(
      getMeHandler.handler,
      setWebhookHandler.handler,
      setCommandsHandler.handler,
    );

    const response = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(
      expect.objectContaining({
        id: botId,
        username: `bot_${botId}`,
        agent: { id: composeId, name },
        isOwner: true,
        isConnected: false,
        domainConfigured: false,
      }),
    );
    expect(body.environment).toBeDefined();

    expect(getMeHandler.mocked).toHaveBeenCalledTimes(1);
    expect(setWebhookHandler.mocked).toHaveBeenCalledTimes(1);
    expect(setCommandsHandler.mocked).toHaveBeenCalledTimes(1);
  });

  it("uses the active org default agent when defaultAgentId is omitted", async () => {
    const user = await context.setupUser();

    const botId = testBotId();
    const { composeId, name } = await createTestCompose(uniqueId("agent"));
    await updateOrgDefaultAgent(user.orgId, composeId);

    const getMeHandler = telegramGetMe(botId, `default_bot_${botId}`);
    const setWebhookHandler = telegramSetWebhook(true);
    const setCommandsHandler = telegramSetMyCommands();
    server.use(
      getMeHandler.handler,
      setWebhookHandler.handler,
      setCommandsHandler.handler,
    );

    const response = await POST(registerRequest({ botToken: TEST_BOT_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.id).toBe(botId);
    expect(body.agent).toEqual({ id: composeId, name });
  });

  it("rejects an empty defaultAgentId instead of falling back to the org default", async () => {
    const user = await context.setupUser();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    await updateOrgDefaultAgent(user.orgId, composeId);

    const getMeHandler = telegramGetMe(testBotId(), "empty_default_bot");
    server.use(getMeHandler.handler);

    const response = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: "" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("defaultAgentId");
    expect(getMeHandler.mocked).not.toHaveBeenCalled();
  });

  it("returns 409 when bot is already registered", async () => {
    await context.setupUser();

    const botId = testBotId();
    const { composeId } = await createTestCompose(uniqueId("agent"));

    const getMeHandler = telegramGetMe(botId, `dup_bot_${botId}`);
    const setWebhookHandler = telegramSetWebhook(true);
    const setCommandsHandler = telegramSetMyCommands();
    server.use(
      getMeHandler.handler,
      setWebhookHandler.handler,
      setCommandsHandler.handler,
    );

    // First registration succeeds
    const first = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    expect(first.status).toBe(201);

    // Second registration returns conflict
    const second = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    const body = await second.json();

    expect(second.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("/connect");
  });

  it("reinstalls an existing bot when reinstallBotId matches the token bot id", async () => {
    await context.setupUser();

    const botId = testBotId();
    const { composeId } = await createTestCompose(uniqueId("agent"));

    server.use(
      telegramGetMe(botId, `reinstall_bot_${botId}`).handler,
      telegramSetWebhook(true).handler,
      telegramSetMyCommands().handler,
    );

    const first = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    expect(first.status).toBe(201);

    const newGetMeHandler = telegramGetMe(
      botId,
      `reinstall_bot_${botId}`,
      NEW_BOT_TOKEN,
    );
    const newSetWebhookHandler = telegramSetWebhook(true, NEW_BOT_TOKEN);
    const newSetCommandsHandler = telegramSetMyCommands(NEW_BOT_TOKEN);
    server.use(
      newGetMeHandler.handler,
      newSetWebhookHandler.handler,
      newSetCommandsHandler.handler,
    );

    const second = await POST(
      registerRequest({ botToken: NEW_BOT_TOKEN, reinstallBotId: botId }),
    );
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body).toMatchObject({
      id: botId,
      tokenStatus: "valid",
      agent: { id: composeId },
    });
    expect(newSetWebhookHandler.mocked).toHaveBeenCalledTimes(1);
    expect(newSetCommandsHandler.mocked).toHaveBeenCalledTimes(1);

    await expect(getTestTelegramBotToken(botId)).resolves.toBe(NEW_BOT_TOKEN);
  });

  it("rejects reinstall when the token belongs to a different bot", async () => {
    await context.setupUser();

    const botId = testBotId();
    const otherBotId = testBotId();
    const { composeId } = await createTestCompose(uniqueId("agent"));

    server.use(
      telegramGetMe(botId, `mismatch_bot_${botId}`).handler,
      telegramSetWebhook(true).handler,
      telegramSetMyCommands().handler,
    );

    const first = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    expect(first.status).toBe(201);

    const otherGetMeHandler = telegramGetMe(
      otherBotId,
      `other_bot_${otherBotId}`,
      NEW_BOT_TOKEN,
    );
    const newSetWebhookHandler = telegramSetWebhook(true, NEW_BOT_TOKEN);
    server.use(otherGetMeHandler.handler, newSetWebhookHandler.handler);

    const response = await POST(
      registerRequest({ botToken: NEW_BOT_TOKEN, reinstallBotId: botId }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("different Telegram bot");
    expect(newSetWebhookHandler.mocked).not.toHaveBeenCalled();
  });

  it("returns 400 when no default agent is available", async () => {
    await context.setupUser();

    const botId = testBotId();
    const getMeHandler = telegramGetMe(botId, `noagent_bot_${botId}`);
    server.use(getMeHandler.handler);

    const response = await POST(registerRequest({ botToken: TEST_BOT_TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("No default agent specified");
    expect(body.error.message).not.toContain("VM0_DEFAULT_AGENT");
  });

  it("returns 404 when defaultAgentId references a nonexistent agent", async () => {
    await context.setupUser();

    const botId = testBotId();
    const getMeHandler = telegramGetMe(botId, `ghost_bot_${botId}`);
    server.use(getMeHandler.handler);

    const response = await POST(
      registerRequest({
        botToken: TEST_BOT_TOKEN,
        defaultAgentId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Agent not found");
  });

  it("returns 403 when defaultAgentId belongs to another org", async () => {
    const user = await context.setupUser();
    const otherCompose = await context.createAgentCompose(user.userId, {
      name: uniqueId("other-agent"),
    });

    const botId = testBotId();
    const getMeHandler = telegramGetMe(botId, `cross_org_bot_${botId}`);
    server.use(getMeHandler.handler);

    const response = await POST(
      registerRequest({
        botToken: TEST_BOT_TOKEN,
        defaultAgentId: otherCompose.id,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("rolls back installation when webhook registration fails", async () => {
    await context.setupUser();

    const botId = testBotId();
    const { composeId } = await createTestCompose(uniqueId("agent"));

    const getMeHandler = telegramGetMe(botId, `fail_bot_${botId}`);
    const setWebhookHandler = telegramSetWebhook(false);
    server.use(getMeHandler.handler, setWebhookHandler.handler);

    const response = await POST(
      registerRequest({ botToken: TEST_BOT_TOKEN, defaultAgentId: composeId }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("BAD_GATEWAY");
  });
});
