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

const URL =
  "http://localhost:3000/api/zero/integrations/telegram/download-file";

const context = testContext();

describe("GET /api/zero/integrations/telegram/download-file", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function authedRequest(
    fileId: string,
    botId = "tg-bot",
  ): Promise<Request> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    return createTestRequest(`${URL}?file_id=${fileId}&bot_id=${botId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 401 when no auth token provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `${URL}?file_id=tg-file-1&bot_id=tg-bot`,
      {
        method: "GET",
      },
    );
    const response = await GET(request as never);

    expect(response.status).toBe(401);
  });

  it("returns 400 when file_id query param is missing", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    const request = createTestRequest(`${URL}?bot_id=tg-bot`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when bot_id query param is missing", async () => {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    const request = createTestRequest(`${URL}?file_id=tg-file-1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when the bot id is not known in the org", async () => {
    const request = await authedRequest("tg-missing", "unknown-bot");
    const response = await GET(request as never);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("streams Telegram file bytes with content-type header", async () => {
    const botId = await createTestTelegramInstallation({
      telegramBotId: "tg-bot-ok",
      orgId: user.orgId,
      ownerUserId: user.userId,
    });

    const fileBytes = Buffer.from("telegram image bytes");
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/getFile",
        async ({ request }) => {
          const body = (await request.json()) as { file_id?: string };
          expect(body.file_id).toBe("tg-file-ok");
          return HttpResponse.json({
            ok: true,
            result: {
              file_id: "tg-file-ok",
              file_unique_id: "unique-1",
              file_size: fileBytes.length,
              file_path: "photos/tg-file-ok.jpg",
            },
          });
        },
      ),
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/photos/tg-file-ok.jpg",
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

    const request = await authedRequest("tg-file-ok", botId);
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-mimetype")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("tg-file-ok.jpg");

    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("returns 413 when Telegram reports a file over the proxy limit", async () => {
    const botId = await createTestTelegramInstallation({
      telegramBotId: "tg-bot-big",
      orgId: user.orgId,
      ownerUserId: user.userId,
    });

    server.use(
      http.post("https://api.telegram.org/bottest-bot-token/getFile", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            file_id: "tg-file-big",
            file_unique_id: "unique-big",
            file_size: 200 * 1024 * 1024,
            file_path: "documents/big.bin",
          },
        });
      }),
    );

    const request = await authedRequest("tg-file-big", botId);
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(413);
    expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 413 when download content-length exceeds the proxy limit", async () => {
    const botId = await createTestTelegramInstallation({
      telegramBotId: "tg-bot-huge-response",
      orgId: user.orgId,
      ownerUserId: user.userId,
    });

    server.use(
      http.post("https://api.telegram.org/bottest-bot-token/getFile", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            file_id: "tg-file-huge-response",
            file_unique_id: "unique-huge-response",
            file_path: "documents/huge-response.bin",
          },
        });
      }),
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/huge-response.bin",
        () => {
          return new HttpResponse(Buffer.from("not actually huge"), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(200 * 1024 * 1024),
            },
          });
        },
      ),
    );

    const request = await authedRequest("tg-file-huge-response", botId);
    const response = await GET(request as never);
    const data = await response.json();

    expect(response.status).toBe(413);
    expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
