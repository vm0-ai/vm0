import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import { createTestTelegramInstallation } from "../../../../../../../../src/__tests__/db-test-seeders/telegram";
import { seedTestRun } from "../../../../../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../../src/mocks/server";
import { findTestRunUploadedFiles } from "../../../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";

const URL =
  "http://localhost:3000/api/zero/integrations/telegram/upload-file/complete";

const context = testContext();

describe("POST /api/zero/integrations/telegram/upload-file/complete", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroTokenWithRun(): Promise<{
    token: string;
    runId: string;
  }> {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      triggerSource: "telegram",
    });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, runId, user.orgId);
    return { token, runId };
  }

  function completeRequest(body: unknown, token?: string): NextRequest {
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

  it("sends the uploaded file URL through the requested Telegram bot", async () => {
    const { token, runId } = await zeroTokenWithRun();
    const botId = await createTestTelegramInstallation({
      telegramBotId: uniqueId("tg-bot-upload"),
      orgId: user.orgId,
      ownerUserId: user.userId,
    });
    const uploadId = randomUUID();
    const telegramFileId = uniqueId("tg-doc-file-id");
    const s3Key = `uploads/${user.userId}/${uploadId}/report.pdf`;
    const fileUrl = `http://localhost:3000/f/${encodeURIComponent(user.userId)}/${uploadId}/report.pdf`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 1234 },
    ]);

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendDocument",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 321,
              chat: { id: -1001234567890 },
              document: {
                file_id: telegramFileId,
                file_unique_id: "tg-doc-unique",
                file_name: "report.pdf",
                mime_type: "application/pdf",
                file_size: 1234,
              },
            },
          });
        },
      ),
    );

    const response = await POST(
      completeRequest(
        {
          uploadId,
          botId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
          caption: "Daily report",
          messageThreadId: 42,
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    expect(telegramBody).toMatchObject({
      chat_id: "-1001234567890",
      document: fileUrl,
      caption: "Daily report",
      message_thread_id: 42,
    });
    expect(await response.json()).toMatchObject({
      messageId: 321,
      chatId: "-1001234567890",
      fileId: telegramFileId,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: fileUrl,
    });

    const rows = await findTestRunUploadedFiles("telegram", telegramFileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "telegram",
      externalId: telegramFileId,
      userId: user.userId,
      orgId: user.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: fileUrl,
      metadata: {
        botId,
        chatId: "-1001234567890",
        uploadId,
        sourceUrl: fileUrl,
        caption: "Daily report",
        messageThreadId: 42,
        telegramMessage: {
          id: 321,
          fileId: telegramFileId,
        },
      },
    });
  });

  it("returns 404 when the bot id is not owned by the org", async () => {
    const { token } = await zeroTokenWithRun();
    const uploadId = randomUUID();

    const response = await POST(
      completeRequest(
        {
          uploadId,
          botId: "unknown-bot",
          chatId: "-1001234567890",
        },
        token,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when Telegram rejects the sendDocument call", async () => {
    const { token } = await zeroTokenWithRun();
    const botId = await createTestTelegramInstallation({
      telegramBotId: uniqueId("tg-bot-reject"),
      orgId: user.orgId,
      ownerUserId: user.userId,
    });
    const uploadId = randomUUID();
    const s3Key = `uploads/${user.userId}/${uploadId}/report.pdf`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 1234 },
    ]);
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendDocument",
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
      completeRequest(
        {
          uploadId,
          botId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
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
