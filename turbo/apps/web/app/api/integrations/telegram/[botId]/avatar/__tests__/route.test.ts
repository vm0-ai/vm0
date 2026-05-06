import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { GET } from "../route";
import {
  createTestRequest,
  createTestTelegramInstallation,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../../src/mocks/server";
import { buildTelegramBotAvatarUrl } from "../../../../../../../src/lib/zero/telegram/avatar-url";
import { reloadEnv } from "../../../../../../../src/env";

const context = testContext();
const OFFICIAL_BOT_TOKEN = "777000:official-avatar-token";

function avatarUrl(botId: string): string {
  return `http://localhost:3000/api/integrations/telegram/${botId}/avatar`;
}

function routeParams(botId: string) {
  return { params: Promise.resolve({ botId }) };
}

function setupOfficialTelegramEnv() {
  vi.stubEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  reloadEnv();
}

function mockTelegramAvatarDownload(
  botId: string,
  fileBytes: Buffer,
  options: {
    token?: string;
    expectedProfileUserId?: string | number;
  } = {},
) {
  const token = options.token ?? "test-bot-token";
  const expectedProfileUserId = options.expectedProfileUserId ?? Number(botId);

  server.use(
    http.post(
      `https://api.telegram.org/bot${token}/getUserProfilePhotos`,
      async ({ request }) => {
        const body = (await request.json()) as {
          user_id?: string | number;
          limit?: number;
        };
        expect(body).toMatchObject({
          user_id: expectedProfileUserId,
          limit: 1,
        });
        return HttpResponse.json({
          ok: true,
          result: {
            total_count: 1,
            photos: [
              [
                {
                  file_id: "small-avatar",
                  file_unique_id: "small-unique",
                  width: 64,
                  height: 64,
                },
                {
                  file_id: "large-avatar",
                  file_unique_id: "large-unique",
                  width: 320,
                  height: 320,
                  file_size: fileBytes.length,
                },
              ],
            ],
          },
        });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${token}/getFile`,
      async ({ request }) => {
        const body = (await request.json()) as { file_id?: string };
        expect(body.file_id).toBe("large-avatar");
        return HttpResponse.json({
          ok: true,
          result: {
            file_id: "large-avatar",
            file_unique_id: "large-unique",
            file_size: fileBytes.length,
            file_path: "photos/avatar.jpg",
          },
        });
      },
    ),
    http.get(
      `https://api.telegram.org/file/bot${token}/photos/avatar.jpg`,
      () => {
        return new HttpResponse(fileBytes, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(fileBytes.length),
          },
        });
      },
    ),
  );
}

describe("GET /api/integrations/telegram/[botId]/avatar", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(avatarUrl("tg-bot")),
      routeParams("tg-bot"),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the bot is not visible in the active org", async () => {
    const response = await GET(
      createTestRequest(avatarUrl("missing-bot")),
      routeParams("missing-bot"),
    );
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("streams the largest Telegram profile photo for the bot", async () => {
    const botId = uniqueNumericId();
    await createTestTelegramInstallation({
      telegramBotId: botId,
      orgId: user.orgId,
      ownerUserId: user.userId,
    });
    const fileBytes = Buffer.from("telegram avatar bytes");
    mockTelegramAvatarDownload(botId, fileBytes);

    const response = await GET(
      createTestRequest(avatarUrl(botId)),
      routeParams(botId),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");

    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("streams a signed bot avatar URL without an Authorization header", async () => {
    const botId = uniqueNumericId();
    await createTestTelegramInstallation({
      telegramBotId: botId,
      orgId: user.orgId,
      ownerUserId: user.userId,
    });
    mockClerk({ userId: null });
    const fileBytes = Buffer.from("signed telegram avatar bytes");
    mockTelegramAvatarDownload(botId, fileBytes);

    const response = await GET(
      createTestRequest(buildTelegramBotAvatarUrl(botId)),
      routeParams(botId),
    );

    expect(response.status).toBe(200);
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("streams the official Telegram bot profile photo from the configured token", async () => {
    setupOfficialTelegramEnv();
    mockClerk({ userId: null });
    const fileBytes = Buffer.from("official telegram avatar bytes");
    mockTelegramAvatarDownload(OFFICIAL_TELEGRAM_BOT_ID, fileBytes, {
      token: OFFICIAL_BOT_TOKEN,
      expectedProfileUserId: 777000,
    });

    const response = await GET(
      createTestRequest(buildTelegramBotAvatarUrl(OFFICIAL_TELEGRAM_BOT_ID)),
      routeParams(OFFICIAL_TELEGRAM_BOT_ID),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("returns a fallback avatar when Telegram has no profile photo for the bot", async () => {
    const botId = uniqueId("tg-bot-no-avatar");
    await createTestTelegramInstallation({
      telegramBotId: botId,
      orgId: user.orgId,
      ownerUserId: user.userId,
    });

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/getUserProfilePhotos",
        () => {
          return HttpResponse.json({
            ok: true,
            result: {
              total_count: 0,
              photos: [],
            },
          });
        },
      ),
    );

    const response = await GET(
      createTestRequest(avatarUrl(botId)),
      routeParams(botId),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(body).toContain("Telegram bot avatar fallback");
  });
});
