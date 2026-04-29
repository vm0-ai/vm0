import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import {
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestTelegramInstallation } from "../../../../../../../src/__tests__/db-test-seeders/telegram";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../src/mocks/server";

const URL = "http://localhost:3000/api/zero/integrations/telegram/bots";

const context = testContext();

describe("GET /api/zero/integrations/telegram/bots", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroToken(): Promise<string> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    return generateZeroToken(user.userId, "run-1", user.orgId);
  }

  async function authedRequest(): Promise<Request> {
    const token = await zeroToken();
    return createTestRequest(URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 401 when no auth token is provided", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(URL, { method: "GET" }));

    expect(response.status).toBe(401);
  });

  it("lists Telegram bots in the active org", async () => {
    const botId = await createTestTelegramInstallation({
      telegramBotId: "123456789",
      ownerUserId: user.userId,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await createTestTelegramInstallation({
      telegramBotId: "987654321",
      ownerUserId: "other-owner",
      orgId: user.orgId,
    });
    await createTestTelegramInstallation({
      telegramBotId: "555555555",
      ownerUserId: user.userId,
    });

    server.use(
      http.post("https://api.telegram.org/bottest-bot-token/getMe", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Bot",
            username: "alerts_bot",
          },
        });
      }),
    );

    const response = await GET((await authedRequest()) as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.bots).toHaveLength(2);
    expect(data.bots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: botId,
          username: "bot_123456789",
          isOwner: true,
          isConnected: true,
          tokenStatus: "valid",
          agent: expect.objectContaining({ id: expect.any(String) }),
        }),
        expect.objectContaining({
          id: "987654321",
          isOwner: false,
          isConnected: false,
        }),
      ]),
    );
    expect(
      data.bots.some((bot: { id: string }) => {
        return bot.id === "555555555";
      }),
    ).toBe(false);
  });

  it("returns an empty list when the active org has no Telegram bots", async () => {
    const response = await GET((await authedRequest()) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ bots: [] });
  });
});
