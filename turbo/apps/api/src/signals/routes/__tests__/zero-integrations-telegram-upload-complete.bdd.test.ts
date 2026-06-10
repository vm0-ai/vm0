import { randomUUID } from "node:crypto";
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

// BDD migration of the legacy
// `zero-integrations-telegram-upload-complete.test.ts`. The
// 4 legacy `it()`s collapse into 2 BDD `it()`s: (1) auth +
// 404 chain (403 no org context → 404 bot id not owned by
// the org), (2) 200/400 success chain (200 sends the
// uploaded file URL through the requested Telegram bot with
// the full DB read-after-write verification of the
// `runUploadedFiles` row → 400 Telegram rejects the
// sendDocument call with the upstream error forwarded).
//
// Service-Level Exception: the upstream Telegram
// sendDocument API is mocked via MSW handlers. The
// `runUploadedFiles` row created by the route is read
// directly via `writeDb$` because no public follow-up GET
// endpoint exists for a single uploaded file.

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

function findUploadedFiles(externalId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.externalId, externalId));
}

describe("BDD POST /api/zero/integrations/telegram/upload-file/complete — auth + 404 chain", () => {
  it("gwt-wt-wt: 403 no org context → 404 bot id not owned by the org", async () => {
    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );

    // Given: a session where the user has no org membership.
    const noOrgUserId = `user_${randomUUID().slice(0, 8)}`;
    const noOrgOrgId = `org_${randomUUID().slice(0, 8)}`;
    const noOrgRunId = `run_${randomUUID()}`;
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    // When + Then: 403 — Organization context required.
    const noOrg = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: uniqueBotId(),
          chatId: "-1001234567890",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: noOrgUserId,
            orgId: noOrgOrgId,
            runId: noOrgRunId,
          })}`,
        },
      }),
      [403],
    );
    expect(noOrg.body).toStrictEqual({
      error: {
        message: "Organization context is required",
        code: "FORBIDDEN",
      },
    });

    // Given: a fresh org membership, but the requested botId
    // is not owned by the org.
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );

    // When + Then: 404.
    const notOwned = await accept(
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
    expect(notOwned.body.error.code).toBe("NOT_FOUND");
  });
});

describe("BDD POST /api/zero/integrations/telegram/upload-file/complete — 200/400 success chain", () => {
  it("gwt-wt-wt: 200 sends the uploaded file URL through the Telegram bot + DB row written → 400 Telegram rejects the sendDocument call", async () => {
    const client = setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    );

    // Given: a sendable context.
    const fixture = await seedSendableContext();
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

    // When: complete the upload.
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

    // Then: 200 + the request body sent to Telegram matches
    // + the response body matches the upstream result.
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

    // Then: a `runUploadedFiles` row was persisted with the
    // full provenance metadata.
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

    // Given: a fresh sendable context + Telegram rejects the
    // sendDocument call.
    const errorFixture = await seedSendableContext();
    const errorUploadId = randomUUID();
    const errorS3Key = `artifacts/${errorFixture.userId}/${errorUploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: errorS3Key, size: 1234 },
    ]);
    server.resetHandlers();
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

    // When + Then: 400 TELEGRAM_ERROR + the upstream error
    // message is forwarded.
    const errorResponse = await accept(
      client.complete({
        body: {
          uploadId: errorUploadId,
          botId: errorFixture.telegramBotId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: errorFixture.userId,
            orgId: errorFixture.orgId,
            runId: errorFixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(errorResponse.body.error.message).toContain("chat not found");
    expect(errorResponse.body.error.code).toBe("TELEGRAM_ERROR");
  });
});

afterEach(async () => {
  // The legacy test pattern accumulates fixtures in a
  // package-scope array; we keep cleanup here to wipe any
  // leftover rows after the BDD chains run. The fixtures
  // themselves are scoped to individual `it()`s.
  const writeDb = store.set(writeDb$);
  await writeDb.delete(runUploadedFiles);
  // Cleanup telegram fixtures and org memberships created
  // by the chains above.
  await store
    .set(
      deleteTelegramFixture$,
      {
        orgId: "noop",
        composeIds: [],
        telegramBotIds: [],
        userIds: [],
      },
      context.signal,
    )
    .catch(() => {
      return undefined;
    });
  await store
    .set(
      deleteOrgMembership$,
      {
        orgId: "noop",
        userId: "noop",
      },
      context.signal,
    )
    .catch(() => {
      return undefined;
    });
});
