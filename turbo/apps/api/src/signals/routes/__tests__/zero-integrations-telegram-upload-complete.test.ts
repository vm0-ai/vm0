import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { integrationsTelegramUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function uniqueBotId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

interface UploadCompleteFixture extends TelegramFixture {
  readonly composeId: string;
  readonly telegramBotId: string;
  readonly userId: string;
  readonly runId: string;
  readonly membership: OrgMembershipFixture;
}

async function seedSendableContext(): Promise<UploadCompleteFixture> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const membership = await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  const telegramBotId = uniqueBotId();
  const installation = await store.set(
    seedTelegramInstallation$,
    { orgId, ownerUserId: userId, telegramBotId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId,
      userId,
      composeId: installation.composeId,
      triggerSource: "telegram",
    },
    context.signal,
  );
  return {
    orgId,
    composeIds: [installation.composeId],
    composeId: installation.composeId,
    telegramBotIds: [telegramBotId],
    telegramBotId,
    userIds: [userId],
    userId,
    runId,
    membership,
  };
}

describe("POST /api/zero/integrations/telegram/upload-file/complete", () => {
  const fixtures: UploadCompleteFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

  function findUploadedFiles(externalId: string) {
    const writeDb = store.set(writeDb$);
    return writeDb
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.externalId, externalId));
  }

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
    while (memberships.length > 0) {
      const membership = memberships.pop();
      if (membership) {
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  it("sends the uploaded file URL through the requested Telegram bot", async () => {
    const fixture = await seedSendableContext();
    fixtures.push(fixture);
    memberships.push(fixture.membership);

    const uploadId = randomUUID();
    const telegramFileId = `tg-doc-${randomUUID().slice(0, 8)}`;
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    const fileUrl = `https://cdn.vm7.io/artifacts/${fixture.userId}/${uploadId}/report.pdf`;

    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
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
              chat: { id: -1_001_234_567_890 },
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

    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
          caption: "Daily report",
          messageThreadId: 42,
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [200],
    );

    expect(telegramBody).toMatchObject({
      chat_id: "-1001234567890",
      document: fileUrl,
      caption: "Daily report",
      message_thread_id: 42,
    });
    expect(response.body).toMatchObject({
      messageId: 321,
      chatId: "-1001234567890",
      fileId: telegramFileId,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: fileUrl,
    });

    const rows = await findUploadedFiles(telegramFileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: fixture.runId,
      source: "telegram",
      externalId: telegramFileId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: fileUrl,
      metadata: {
        botId: fixture.telegramBotId,
        chatId: "-1001234567890",
        uploadId,
        s3Key,
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
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    memberships.push(membership);

    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: uniqueBotId(),
          chatId: "-1001234567890",
        },
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 when authenticated without an organization context", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );

    const response = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: uniqueBotId(),
          chatId: "-1001234567890",
        },
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization context is required",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 when Telegram rejects the sendDocument call", async () => {
    const fixture = await seedSendableContext();
    fixtures.push(fixture);
    memberships.push(fixture.membership);

    const uploadId = randomUUID();
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
    ]);

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendDocument",
        () => {
          return HttpResponse.json(
            { ok: false, description: "Bad Request: chat not found" },
            { status: 400 },
          );
        },
      ),
    );

    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("chat not found");
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
  });
});
