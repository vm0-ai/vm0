import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsTelegramUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import {
  testTelegramStateContract,
  type TestTelegramStateSeedResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TELEGRAM_BOT_TOKEN = "123456:e2e-test-bot-token";

interface SeededTelegramInstallation {
  readonly botId: string;
  readonly response: TestTelegramStateSeedResponse;
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

function telegramWriteHeaders(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): { readonly authorization: string } {
  mockMembership(args.userId, args.orgId);
  const token = zeroToken({
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
  });
  return { authorization: `Bearer ${token}` };
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
  const botId = `bot_upload_complete_gap_${id}`;
  const userId = `user_upload_complete_gap_${id}`;
  const orgId = `org_upload_complete_gap_${id}`;
  mockMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        bot_id: botId,
        telegram_user_id: `telegram_upload_complete_gap_${id}`,
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
): void {
  const remaining = [...responses];
  server.use(
    http.post(telegramSendDocumentUrl(), () => {
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
}

function successResponse(args: {
  readonly messageId: number;
  readonly fileId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
}): TelegramMockResponse {
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        message_id: args.messageId,
        chat: { id: -1_001_234_567_890 },
        document: {
          file_id: args.fileId,
          file_unique_id: `${args.fileId}_unique`,
          file_name: args.filename,
          mime_type: args.mimetype,
          file_size: args.size,
        },
      },
    },
  };
}

function artifactUrl(args: {
  readonly userId: string;
  readonly uploadId: string;
  readonly filename: string;
}): string {
  return `https://cdn.vm7.io/artifacts/${args.userId}/${args.uploadId}/${args.filename}`;
}

function findUploadedFiles(externalId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.source, "telegram"),
        eq(runUploadedFiles.externalId, externalId),
      ),
    );
}

describe("POST /api/zero/integrations/telegram/upload-file/complete helper gaps", () => {
  it("gap-telegram-upload-complete-01: records only run-scoped Telegram uploads and upserts by file id", async () => {
    const installation = await createTelegramInstallation();
    const runId = installation.telegram_run_id;
    if (!runId) {
      throw new Error("Expected the Telegram state route to seed a run");
    }

    const noRunUploadId = randomUUID();
    const firstRunUploadId = randomUUID();
    const secondRunUploadId = randomUUID();
    const noRunFileId = `tg-no-run-${suffix()}`;
    const upsertFileId = `tg-upsert-${suffix()}`;
    const noRunUrl = artifactUrl({
      userId: installation.vm0_user_id,
      uploadId: noRunUploadId,
      filename: "no-run.pdf",
    });
    const firstRunUrl = artifactUrl({
      userId: installation.vm0_user_id,
      uploadId: firstRunUploadId,
      filename: "report.pdf",
    });
    const secondRunUrl = artifactUrl({
      userId: installation.vm0_user_id,
      uploadId: secondRunUploadId,
      filename: "report-v2.txt",
    });

    mockTelegramDocumentResponses([
      successResponse({
        messageId: 901,
        fileId: noRunFileId,
        filename: "no-run.pdf",
        mimetype: "application/pdf",
        size: 111,
      }),
      successResponse({
        messageId: 902,
        fileId: upsertFileId,
        filename: "report.pdf",
        mimetype: "application/pdf",
        size: 1234,
      }),
      successResponse({
        messageId: 903,
        fileId: upsertFileId,
        filename: "report-v2.txt",
        mimetype: "text/plain",
        size: 77,
      }),
    ]);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${installation.vm0_user_id}/${noRunUploadId}/no-run.pdf`,
        size: 111,
      },
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${installation.vm0_user_id}/${firstRunUploadId}/report.pdf`,
        size: 1234,
      },
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${installation.vm0_user_id}/${secondRunUploadId}/report-v2.txt`,
        size: 77,
      },
    ]);

    mocks.clerk.session(installation.vm0_user_id, installation.org_id);
    const noRun = await accept(
      client().complete({
        body: {
          uploadId: noRunUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(noRun.body).toStrictEqual({
      messageId: 901,
      chatId: "-1001234567890",
      fileId: noRunFileId,
      filename: "no-run.pdf",
      mimetype: "application/pdf",
      size: 111,
      url: noRunUrl,
    });
    await expect(findUploadedFiles(noRunFileId)).resolves.toHaveLength(0);

    const headers = telegramWriteHeaders({
      userId: installation.vm0_user_id,
      orgId: installation.org_id,
      runId,
    });
    const firstRunUpload = await accept(
      client().complete({
        body: {
          uploadId: firstRunUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "application/pdf",
          caption: "Daily report",
        },
        headers,
      }),
      [200],
    );

    expect(firstRunUpload.body).toMatchObject({
      messageId: 902,
      fileId: upsertFileId,
      url: firstRunUrl,
    });
    await expect(findUploadedFiles(upsertFileId)).resolves.toHaveLength(1);

    const secondRunUpload = await accept(
      client().complete({
        body: {
          uploadId: secondRunUploadId,
          botId: installation.bot_id,
          chatId: "-1001234567890",
          contentType: "text/plain",
          caption: "Updated report",
        },
        headers,
      }),
      [200],
    );

    expect(secondRunUpload.body).toMatchObject({
      messageId: 903,
      fileId: upsertFileId,
      filename: "report-v2.txt",
      url: secondRunUrl,
    });

    const rows = await findUploadedFiles(upsertFileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "telegram",
      externalId: upsertFileId,
      userId: installation.vm0_user_id,
      orgId: installation.org_id,
      filename: "report-v2.txt",
      contentType: "text/plain",
      sizeBytes: 77,
      url: secondRunUrl,
      metadata: {
        botId: installation.bot_id,
        chatId: "-1001234567890",
        uploadId: secondRunUploadId,
        s3Key: `artifacts/${installation.vm0_user_id}/${secondRunUploadId}/report-v2.txt`,
        sourceUrl: secondRunUrl,
        caption: "Updated report",
        telegramMessage: {
          id: 903,
          fileId: upsertFileId,
        },
      },
    });
  });
});
