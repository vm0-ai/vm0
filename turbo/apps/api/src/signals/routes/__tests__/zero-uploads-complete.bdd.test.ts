import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { seedCompose$, seedRun$ } from "./helpers/zero-usage-insight";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-uploads-complete.test.ts`.
// The 12 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth + bad-request + forbidden chain (401 unauthenticated →
// 400 invalid body shape → 400 unsupported content type →
// 403 zero token without `file:write`), (2) success body
// shape + content-type + idempotency chain (200 zero-token
// complete returns shape + records run association +
// publishes chat-thread signal + uses validated content type
// + infers audio content type + is idempotent on retry +
// session auth does NOT record a run association), (3)
// failure chain (404 when S3 object not found → 402 when
// org is suspended).
//
// Service-Level Exception: `orgMetadata` rows are seeded
// directly via `writeDb$` to control the org tier for the
// 402 case.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroUploadsContract);
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  userId: string;
  orgId: string;
  runId: string;
  capabilities?: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities ?? ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedOrgTier(
  orgId: string,
  tier: "free" | "pro-suspend",
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(orgMetadata)
    .values({ orgId, tier, credits: 10_000 })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier, credits: 10_000 },
    });
}

const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

function findUploadedFiles(externalId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.externalId, externalId));
}

function findUploadedFilesForRun(runId: string, externalId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, runId),
        eq(runUploadedFiles.externalId, externalId),
      ),
    );
}

/**
 * Seed compose+agent+run, optionally linked to a chat thread.
 * Returns { userId, orgId, composeId, runId, threadId? }.
 */
async function seedRunFixture(opts: {
  withChatThread?: boolean;
  triggerSource?: string;
}): Promise<{
  userId: string;
  orgId: string;
  composeId: string;
  runId: string;
  threadId?: string;
}> {
  if (opts.withChatThread) {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    await seedOrgTier(fixture.orgId, "free");
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        triggerSource: opts.triggerSource ?? "web",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    return {
      userId: fixture.userId,
      orgId: fixture.orgId,
      composeId: fixture.composeId,
      runId,
      threadId: fixture.threadId,
    };
  }

  const userId = `user_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await seedOrgTier(orgId, "free");
  const { composeId } = await store.set(
    seedCompose$,
    { orgId, userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId,
      userId,
      composeId,
      triggerSource: opts.triggerSource ?? "web",
    },
    context.signal,
  );
  return { userId, orgId, composeId, runId };
}

function s3Object(userId: string, fileId: string, ext: string, size = 1234) {
  return {
    bucket: "test-user-artifacts",
    key: `artifacts/${userId}/${fileId}/${ext}`,
    size,
  };
}

describe("BDD POST /api/zero/uploads/complete — auth + bad-request + forbidden chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 400 invalid body shape → 400 unsupported content type → 403 zero token without file:write", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().complete({
        headers: {},
        body: { id: randomUUID() },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + a zero token + an invalid id.

    // When + Then: 400 — invalid request body.
    const badBodyFixture = await seedRunFixture({});
    const badBodyToken = zeroToken(badBodyFixture);
    const badBodyResponse = await accept(
      apiClient().complete({
        headers: authHeaders(badBodyToken),
        body: { id: "not-a-uuid" },
      }),
      [400],
    );
    expect(badBodyResponse.body).toStrictEqual({
      error: { message: "Invalid request body", code: "BAD_REQUEST" },
    });

    // Given: a fixture + a zero token + an unsupported
    // content type.

    // When + Then: 400 — unsupported file type.
    const unsupportedFixture = await seedRunFixture({});
    const unsupportedToken = zeroToken(unsupportedFixture);
    const unsupportedResponse = await accept(
      apiClient().complete({
        headers: authHeaders(unsupportedToken),
        body: {
          id: randomUUID(),
          contentType: "application/x-msdownload",
        },
      }),
      [400],
    );
    expect(unsupportedResponse.body).toStrictEqual({
      error: {
        message: "Unsupported file type: application/x-msdownload",
        code: "BAD_REQUEST",
      },
    });

    // Given: a fixture + a zero token without
    // `file:write`.

    // When + Then: 403 — FORBIDDEN.
    const forbiddenFixture = await seedRunFixture({});
    const forbiddenToken = zeroToken({
      ...forbiddenFixture,
      capabilities: ["file:read"],
    });
    const forbiddenResponse = await accept(
      apiClient().complete({
        headers: authHeaders(forbiddenToken),
        body: { id: randomUUID() },
      }),
      [403],
    );
    expect(forbiddenResponse.body.error.code).toBe("FORBIDDEN");
    expect(forbiddenResponse.body.error.message).toContain("file:write");
  });
});

describe("BDD POST /api/zero/uploads/complete — success body shape + content-type + idempotency chain", () => {
  it("gwt-wt-wt: 200 zero-token complete returns shape + records run association + publishes chat-thread signal + uses validated content type + infers audio content type + is idempotent on retry + session auth does NOT record a run association", async () => {
    // Given: a fixture + an S3 object present.

    // When + Then: 200 — the response carries the expected
    // shape + the run association is recorded.
    const fixture = await seedRunFixture({});
    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(fixture.userId, fileId, "report.pdf")]);
    const token = zeroToken(fixture);
    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      id: fileId,
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    const rows = await findUploadedFiles(fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: fixture.runId,
      source: "web",
      externalId: fileId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(rows[0]?.metadata).toMatchObject({
      s3Key: `artifacts/${fixture.userId}/${fileId}/report.pdf`,
    });

    // Given: a chat-thread run + an S3 object present.

    // When + Then: 200 — the chat-thread artifacts changed
    // signal is published.
    const chatFixture = await seedRunFixture({ withChatThread: true });
    const chatFileId = randomUUID();
    mocks.s3.listObjects([
      s3Object(chatFixture.userId, chatFileId, "artifact.zip"),
    ]);
    const chatToken = zeroToken({
      userId: chatFixture.userId,
      orgId: chatFixture.orgId,
      runId: chatFixture.runId,
    });
    await accept(
      apiClient().complete({
        headers: authHeaders(chatToken),
        body: { id: chatFileId },
      }),
      [200],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadArtifactsChanged:${chatFixture.threadId}`,
      null,
    );

    // Given: a fixture + an S3 object present + a validated
    // content type override.

    // When + Then: 200 — the override content type is
    // used.
    const overrideFixture = await seedRunFixture({});
    const overrideFileId = randomUUID();
    mocks.s3.listObjects([
      s3Object(overrideFixture.userId, overrideFileId, "data.bin", 9),
    ]);
    const overrideToken = zeroToken(overrideFixture);
    const overrideResponse = await accept(
      apiClient().complete({
        headers: authHeaders(overrideToken),
        body: { id: overrideFileId, contentType: "text/csv" },
      }),
      [200],
    );
    expect(overrideResponse.body).toMatchObject({
      id: overrideFileId,
      filename: "data.bin",
      contentType: "text/csv",
    });
    const overrideRows = await findUploadedFiles(overrideFileId);
    expect(overrideRows[0]).toMatchObject({ contentType: "text/csv" });

    // Given: a fixture + an MP3 file in S3.

    // When + Then: 200 — the audio content type is
    // inferred from the filename.
    const audioFixture = await seedRunFixture({});
    const audioFileId = randomUUID();
    mocks.s3.listObjects([
      s3Object(audioFixture.userId, audioFileId, "clip.mp3", 2048),
    ]);
    const audioToken = zeroToken(audioFixture);
    const audioResponse = await accept(
      apiClient().complete({
        headers: authHeaders(audioToken),
        body: { id: audioFileId },
      }),
      [200],
    );
    expect(audioResponse.body).toMatchObject({
      id: audioFileId,
      filename: "clip.mp3",
      contentType: "audio/mpeg",
      size: 2048,
    });
    const audioRows = await findUploadedFiles(audioFileId);
    expect(audioRows[0]).toMatchObject({
      runId: audioFixture.runId,
      contentType: "audio/mpeg",
      filename: "clip.mp3",
    });

    // Given: a fixture + an S3 object + a zero token.

    // When + Then: 200 first call + 200 second call =
    // idempotent (single row for the run+externalId).
    const idempotentFixture = await seedRunFixture({});
    const idempotentFileId = randomUUID();
    mocks.s3.listObjects([
      s3Object(idempotentFixture.userId, idempotentFileId, "retry.txt", 7),
    ]);
    const idempotentToken = zeroToken(idempotentFixture);
    await accept(
      apiClient().complete({
        headers: authHeaders(idempotentToken),
        body: { id: idempotentFileId },
      }),
      [200],
    );
    await accept(
      apiClient().complete({
        headers: authHeaders(idempotentToken),
        body: { id: idempotentFileId },
      }),
      [200],
    );
    await expect(
      findUploadedFilesForRun(idempotentFixture.runId, idempotentFileId),
    ).resolves.toHaveLength(1);

    // Given: a fresh session + an S3 object.

    // When + Then: 200 — session auth does NOT record a
    // run association.
    const sessionUserId = `user_${randomUUID().slice(0, 8)}`;
    const sessionOrgId = `org_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(sessionUserId, sessionOrgId);
    const sessionFileId = randomUUID();
    mocks.s3.listObjects([
      s3Object(sessionUserId, sessionFileId, "plain.txt", 5),
    ]);
    const sessionResponse = await accept(
      apiClient().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { id: sessionFileId },
      }),
      [200],
    );
    expect(sessionResponse.body).toMatchObject({
      id: sessionFileId,
      filename: "plain.txt",
      size: 5,
    });
    await expect(findUploadedFiles(sessionFileId)).resolves.toHaveLength(0);
  });
});

describe("BDD POST /api/zero/uploads/complete — failure chain", () => {
  it("gwt-wt-wt: 404 when S3 object not found → 402 when org is suspended", async () => {
    // Given: a fixture + S3 returns no objects.

    // When + Then: 404 — Uploaded file not found.
    const missingFixture = await seedRunFixture({});
    const missingFileId = randomUUID();
    mocks.s3.listObjects([]);
    const missingToken = zeroToken(missingFixture);
    const missingResponse = await accept(
      apiClient().complete({
        headers: authHeaders(missingToken),
        body: { id: missingFileId },
      }),
      [404],
    );
    expect(missingResponse.body).toStrictEqual({
      error: { message: "Uploaded file not found", code: "NOT_FOUND" },
    });
    await expect(findUploadedFiles(missingFileId)).resolves.toHaveLength(0);

    // Given: a fixture + the org is suspended
    // (`pro-suspend`).

    // When + Then: 402 — INSUFFICIENT_CREDITS.
    const suspendedFixture = await seedRunFixture({});
    await seedOrgTier(suspendedFixture.orgId, "pro-suspend");
    const suspendedFileId = randomUUID();
    const suspendedToken = zeroToken(suspendedFixture);
    const suspendedResponse = await accept(
      apiClient().complete({
        headers: authHeaders(suspendedToken),
        body: { id: suspendedFileId },
      }),
      [402],
    );
    expect(suspendedResponse.body.error.code).toBe("INSUFFICIENT_CREDITS");
    await expect(findUploadedFiles(suspendedFileId)).resolves.toHaveLength(0);
  });
});
