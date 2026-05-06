import { beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http as mswHttp } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueNumericId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { createTestTelegramInstallation } from "../../../../../src/__tests__/api-test-helpers";

const context = testContext();

const TEST_BOT_TOKEN = "123456:ABC-test-token";

function testBotToken(botId: string): string {
  return `${botId}:ABC-test-token`;
}

function setupStatusRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/telegram/setup-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function telegramGetMe(input: {
  botId: string;
  username: string;
  privacyDisabled?: boolean;
  token?: string;
}) {
  const token = input.token ?? TEST_BOT_TOKEN;
  return http.post(`https://api.telegram.org/bot${token}/getMe`, () => {
    return HttpResponse.json({
      ok: true,
      result: {
        id: Number(input.botId),
        is_bot: true,
        first_name: "Bot",
        username: input.username,
        can_read_all_group_messages: input.privacyDisabled ?? false,
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

function telegramOauthHead(contentLength: string) {
  return mswHttp.head("https://oauth.telegram.org/auth", () => {
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

describe("POST /api/telegram/setup-status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      setupStatusRequest({ botToken: TEST_BOT_TOKEN }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when bot token is invalid", async () => {
    await context.setupUser();
    const handler = telegramGetMeFail();
    server.use(handler.handler);

    const response = await POST(
      setupStatusRequest({ botToken: TEST_BOT_TOKEN }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid bot token");
  });

  it("returns BotFather domain and privacy setup status", async () => {
    await context.setupUser();
    const botId = uniqueNumericId();
    const botToken = testBotToken(botId);
    const getMeHandler = telegramGetMe({
      botId,
      username: "setup_bot",
      privacyDisabled: true,
      token: botToken,
    });
    server.use(getMeHandler.handler, telegramOauthHead("2048"));

    const response = await POST(
      setupStatusRequest({
        botToken,
        origin: "https://app.example.com/settings/telegram",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: botId,
      username: "setup_bot",
      domainConfigured: true,
      privacyDisabled: true,
    });
    expect(getMeHandler.mocked).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the bot is already installed", async () => {
    const user = await context.setupUser();
    const botId = uniqueNumericId();
    const botToken = testBotToken(botId);
    await createTestTelegramInstallation({
      telegramBotId: botId,
      orgId: user.orgId,
    });
    const getMeHandler = telegramGetMe({
      botId,
      username: "setup_bot",
      token: botToken,
    });
    server.use(getMeHandler.handler);

    const response = await POST(setupStatusRequest({ botToken }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("already installed");
  });
});
