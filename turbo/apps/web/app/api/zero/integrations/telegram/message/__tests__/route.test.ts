import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRequest,
  insertOrgMembersCacheEntry,
  insertTestTelegramUserLink,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../../src/__tests__/db-test-seeders/agents";
import { createTestTelegramInstallation } from "../../../../../../../src/__tests__/db-test-seeders/telegram";
import {
  seedTestRun,
  setTestRunSelectedModel,
} from "../../../../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../src/mocks/server";

const URL = "http://localhost:3000/api/zero/integrations/telegram/message";

const context = testContext();

describe("POST /api/zero/integrations/telegram/message", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroTokenWithRun(): Promise<{
    token: string;
    runId: string;
    composeId: string;
  }> {
    const agentName = uniqueId("telegram-agent");
    const { composeId } = await createTestCompose(agentName);
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Assistant",
    });
    const { runId } = await seedTestRun(user.userId, composeId);
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, runId, user.orgId);
    return { token, runId, composeId };
  }

  function messageRequest(body: unknown, token?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return createTestRequest(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when no auth token is provided", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      messageRequest({
        botId: "tg-bot-message",
        chatId: "-1001234567890",
        text: "hello",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("sends a Telegram message and appends the Slack-aligned footer", async () => {
    const { token, runId } = await zeroTokenWithRun();
    await setTestRunSelectedModel(runId, "claude-opus-4-7");
    const telegramBotId = uniqueId("tg-bot-message");
    const botId = await createTestTelegramInstallation({
      telegramBotId,
      orgId: user.orgId,
      ownerUserId: user.userId,
    });
    await insertTestTelegramUserLink({
      installationId: botId,
      telegramUserId: "777000",
      vm0UserId: user.userId,
    });

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 321,
              chat: { id: -1001234567890 },
              text: telegramBody.text,
            },
          });
        },
      ),
    );

    const response = await POST(
      messageRequest(
        {
          botId,
          chatId: "-1001234567890",
          text: "Hello **world**",
          replyToMessageId: 42,
          messageThreadId: 7,
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    expect(telegramBody).toMatchObject({
      chat_id: "-1001234567890",
      parse_mode: "HTML",
      reply_parameters: { message_id: 42 },
      message_thread_id: 7,
    });
    expect(String(telegramBody?.text)).toContain("Hello <b>world</b>");
    expect(String(telegramBody?.text)).toContain(
      '<i>Sent via My Assistant · Triggered by <a href="tg://user?id=777000">Telegram user 777000</a> · Claude Opus 4.7</i>',
    );
    expect(await response.json()).toEqual({
      ok: true,
      messageId: 321,
      chatId: "-1001234567890",
    });
  });

  it("returns 404 when the bot id is not owned by the org", async () => {
    const { token } = await zeroTokenWithRun();

    const response = await POST(
      messageRequest(
        {
          botId: "unknown-bot",
          chatId: "-1001234567890",
          text: "hello",
        },
        token,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when Telegram rejects sendMessage", async () => {
    const { token } = await zeroTokenWithRun();
    const botId = await createTestTelegramInstallation({
      telegramBotId: uniqueId("tg-bot-reject-message"),
      orgId: user.orgId,
      ownerUserId: user.userId,
    });

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        () => {
          return HttpResponse.json(
            {
              ok: false,
              description: "Bad Request: chat not found",
            },
            { status: 400 },
          );
        },
      ),
    );

    const response = await POST(
      messageRequest(
        {
          botId,
          chatId: "-1001234567890",
          text: "hello",
        },
        token,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("chat not found");
    expect(body.error.code).toBe("TELEGRAM_ERROR");
  });
});
