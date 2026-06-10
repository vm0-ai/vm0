import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsTelegramUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import {
  testTelegramStateContract,
  type TestTelegramStateSeedResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const TELEGRAM_BOT_TOKEN = "123456:e2e-test-bot-token";

interface SeededTelegramInstallation {
  readonly botId: string;
  readonly response: TestTelegramStateSeedResponse;
}

interface TelegramWriteAuth {
  readonly headers: { readonly authorization: string };
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}

interface TelegramMockResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function client() {
  return setupApp({ context })(integrationsTelegramUploadCompleteContract);
}

function stateClient() {
  return setupApp({ context })(testTelegramStateContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function mockMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        createdAt: 1,
        organization: { id: orgId },
        role: "org:member",
      },
    ],
  });
}

function telegramWriteAuth(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string | null;
}): TelegramWriteAuth {
  mockMembership(args.userId, args.orgId);
  const runId = args.runId ?? `run_${randomUUID()}`;
  const token = zeroToken({
    userId: args.userId,
    orgId: args.orgId,
    runId,
    capabilities: ["telegram:write"],
  });
  return {
    headers: { authorization: `Bearer ${token}` },
    userId: args.userId,
    orgId: args.orgId,
    runId,
  };
}

async function deleteDefaultAgent(args: {
  readonly agentId: string | null;
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  if (!args.agentId) {
    return;
  }

  mocks.clerk.session(args.userId, args.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      params: { id: args.agentId },
      headers: { authorization: "Bearer clerk-session" },
    }),
    [204, 404, 409],
  );
}

async function cleanupTelegramInstallation(
  installation: SeededTelegramInstallation,
): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { bot_id: installation.botId } }),
    [200],
  );
  await deleteDefaultAgent({
    agentId: installation.response.default_agent_id,
    userId: installation.response.vm0_user_id,
    orgId: installation.response.org_id,
  });
}

const trackTelegramInstallation =
  createFixtureTracker<SeededTelegramInstallation>(cleanupTelegramInstallation);

async function createTelegramInstallation(): Promise<TestTelegramStateSeedResponse> {
  mockEnv("ENV", "development");
  const id = suffix();
  const botId = `bot_upload_complete_${id}`;
  const userId = `user_upload_complete_${id}`;
  const orgId = `org_upload_complete_${id}`;
  mockMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        bot_id: botId,
        telegram_user_id: `telegram_upload_complete_${id}`,
        email: `${id}@example.test`,
        seed_telegram_run: true,
      },
    }),
    [200],
  );

  await trackTelegramInstallation(
    Promise.resolve({ botId, response: response.body }),
  );
  return response.body;
}

function telegramSendDocumentUrl(): RegExp {
  return new RegExp(
    `^https://api\\.telegram\\.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument$`,
  );
}

function mockTelegramDocumentResponses(
  responses: readonly TelegramMockResponse[],
): { readonly bodies: readonly unknown[] } {
  const bodies: unknown[] = [];
  const remaining = [...responses];

  server.use(
    http.post(telegramSendDocumentUrl(), async ({ request }) => {
      bodies.push(await request.json());
      const next = remaining.shift();
      if (!next) {
        return HttpResponse.json(
          { ok: false, description: "Unexpected Telegram request" },
          { status: 500 },
        );
      }
      return HttpResponse.json(next.body, { status: next.status });
    }),
  );

  return { bodies };
}

function successResponse(args: {
  readonly messageId: number;
  readonly chatId?: number;
  readonly document?: Record<string, unknown>;
}): TelegramMockResponse {
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        message_id: args.messageId,
        chat: { id: args.chatId ?? -1_001_234_567_890 },
        ...(args.document ? { document: args.document } : {}),
      },
    },
  };
}

function errorResponse(args: {
  readonly status: number;
  readonly description: string;
}): TelegramMockResponse {
  return {
    status: args.status,
    body: { ok: false, description: args.description },
  };
}

function artifactUrl(args: {
  readonly userId: string;
  readonly uploadId: string;
  readonly filename: string;
}): string {
  return `https://cdn.vm7.io/artifacts/${args.userId}/${args.uploadId}/${args.filename}`;
}

describe("POST /api/zero/integrations/telegram/upload-file/complete BDD", () => {
  it("requires authentication, Telegram write capability, and organization context", async () => {
    const unauthenticated = await accept(
      client().complete({
        body: {
          uploadId: randomUUID(),
          botId: `bot_${suffix()}`,
          chatId: "-1001234567890",
        },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missingCapabilityToken = zeroToken({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
    });
    const missingCapability = await accept(
      client().complete({
        body: {
          uploadId: randomUUID(),
          botId: `bot_${suffix()}`,
          chatId: "-1001234567890",
        },
        headers: { authorization: `Bearer ${missingCapabilityToken}` },
      }),
      [403],
    );

    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: telegram:write",
        code: "FORBIDDEN",
      },
    });

    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const noOrgToken = zeroToken({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["telegram:write"],
    });
    const noOrg = await accept(
      client().complete({
        body: {
          uploadId: randomUUID(),
          botId: `bot_${suffix()}`,
          chatId: "-1001234567890",
        },
        headers: { authorization: `Bearer ${noOrgToken}` },
      }),
      [403],
    );

    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Organization context is required",
        code: "FORBIDDEN",
      },
    });
  });

  it("validates requests and route-visible missing state before calling Telegram", async () => {
    const auth = telegramWriteAuth({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
    });
    const invalid = await accept(
      client().complete({
        body: {
          uploadId: "not-a-uuid",
          botId: "",
          chatId: "",
        },
        headers: auth.headers,
      }),
      [400],
    );

    expect(invalid.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const missingBot = await accept(
      client().complete({
        body: {
          uploadId: randomUUID(),
          botId: `bot_missing_${suffix()}`,
          chatId: "-1001234567890",
        },
        headers: auth.headers,
      }),
      [404],
    );

    expect(missingBot.body).toStrictEqual({
      error: {
        message: "Telegram bot not found",
        code: "NOT_FOUND",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const installation = await createTelegramInstallation();
    const seededAuth = telegramWriteAuth({
      userId: installation.vm0_user_id,
      orgId: installation.org_id,
      runId: installation.telegram_run_id,
    });
    const telegram = mockTelegramDocumentResponses([
      successResponse({ messageId: 123 }),
    ]);
    mocks.s3.listObjects([]);

    const missingUpload = await accept(
      client().complete({
        body: {
          uploadId: randomUUID(),
          botId: installation.bot_id,
          chatId: "-1001234567890",
        },
        headers: seededAuth.headers,
      }),
      [404],
    );

    expect(missingUpload.body).toStrictEqual({
      error: {
        message: "Uploaded file not found",
        code: "NOT_FOUND",
      },
    });
    expect(telegram.bodies).toHaveLength(0);
  });

  it("sends uploaded files through the requested Telegram bot and returns fallback file metadata", async () => {
    const installation = await createTelegramInstallation();
    const auth = telegramWriteAuth({
      userId: installation.vm0_user_id,
      orgId: installation.org_id,
      runId: installation.telegram_run_id,
    });
    const firstUploadId = randomUUID();
    const secondUploadId = randomUUID();
    const firstFileUrl = artifactUrl({
      userId: auth.userId,
      uploadId: firstUploadId,
      filename: "report.pdf",
    });
    const secondFileUrl = artifactUrl({
      userId: auth.userId,
      uploadId: secondUploadId,
      filename: "summary.txt",
    });
    const telegramFileId = `tg-doc-${suffix()}`;
    const telegram = mockTelegramDocumentResponses([
      successResponse({
        messageId: 321,
        document: {
          file_id: telegramFileId,
          file_unique_id: "tg-doc-unique",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 1234,
        },
      }),
      successResponse({ messageId: 322 }),
    ]);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${auth.userId}/${firstUploadId}/report.pdf`,
        size: 1234,
      },
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${auth.userId}/${secondUploadId}/summary.txt`,
        size: 77,
      },
    ]);

    const complete = await accept(
      client().complete({
        body: {
          uploadId: firstUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "application/pdf",
          caption: "Daily report",
          messageThreadId: 42,
        },
        headers: auth.headers,
      }),
      [200],
    );

    expect(complete.body).toStrictEqual({
      messageId: 321,
      chatId: "-1001234567890",
      fileId: telegramFileId,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: firstFileUrl,
    });
    expect(telegram.bodies[0]).toStrictEqual({
      chat_id: "-1001234567890",
      document: firstFileUrl,
      caption: "Daily report",
      message_thread_id: 42,
    });

    const fallback = await accept(
      client().complete({
        body: {
          uploadId: secondUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
        },
        headers: auth.headers,
      }),
      [200],
    );

    expect(fallback.body).toStrictEqual({
      messageId: 322,
      chatId: "-1001234567890",
      filename: "summary.txt",
      mimetype: "text/plain",
      size: 77,
      url: secondFileUrl,
    });
    expect(telegram.bodies[1]).toStrictEqual({
      chat_id: "-1001234567890",
      document: secondFileUrl,
    });
  });

  it("maps Telegram sendDocument client and server errors", async () => {
    const installation = await createTelegramInstallation();
    const auth = telegramWriteAuth({
      userId: installation.vm0_user_id,
      orgId: installation.org_id,
      runId: installation.telegram_run_id,
    });
    const clientErrorUploadId = randomUUID();
    const serverErrorUploadId = randomUUID();
    const telegram = mockTelegramDocumentResponses([
      errorResponse({
        status: 400,
        description: "Bad Request: chat not found",
      }),
      errorResponse({ status: 500, description: "Internal Server Error" }),
    ]);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${auth.userId}/${clientErrorUploadId}/report.pdf`,
        size: 1234,
      },
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${auth.userId}/${serverErrorUploadId}/report.pdf`,
        size: 1234,
      },
    ]);

    const clientError = await accept(
      client().complete({
        body: {
          uploadId: clientErrorUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: auth.headers,
      }),
      [400],
    );

    expect(clientError.body.error).toStrictEqual({
      message: "Telegram API error: Bad Request: chat not found",
      code: "TELEGRAM_ERROR",
    });

    const serverError = await accept(
      client().complete({
        body: {
          uploadId: serverErrorUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: auth.headers,
      }),
      [502],
    );

    expect(serverError.body.error).toStrictEqual({
      message: "Telegram API error: Internal Server Error",
      code: "TELEGRAM_ERROR",
    });
    expect(telegram.bodies).toHaveLength(2);
  });
});
