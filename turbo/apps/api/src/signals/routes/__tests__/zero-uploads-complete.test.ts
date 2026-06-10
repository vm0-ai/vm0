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

describe("POST /api/zero/uploads/complete", () => {
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

  it("records a web upload for a run-scoped zero token after the object exists", async () => {
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
  });

  it("publishes the artifacts changed signal for a chat-thread run upload", async () => {
    const fixture = await seedRunFixture({ withChatThread: true });
    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(fixture.userId, fileId, "artifact.zip")]);

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: fixture.runId,
    });
    await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [200],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadArtifactsChanged:${fixture.threadId}`,
      null,
    );
  });

  it("does not record a run association for ordinary session auth", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, orgId);

    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(userId, fileId, "plain.txt", 5)]);

    const response = await accept(
      apiClient().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { id: fileId },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "plain.txt",
      size: 5,
    });
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });

  it("uses the validated complete content type when provided", async () => {
    const fixture = await seedRunFixture({});
    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(fixture.userId, fileId, "data.bin", 9)]);

    const token = zeroToken(fixture);
    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId, contentType: "text/csv" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "data.bin",
      contentType: "text/csv",
    });
    const rows = await findUploadedFiles(fileId);
    expect(rows[0]).toMatchObject({ contentType: "text/csv" });
  });

  it("infers audio content type from uploaded filename", async () => {
    const fixture = await seedRunFixture({});
    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(fixture.userId, fileId, "clip.mp3", 2048)]);

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
      filename: "clip.mp3",
      contentType: "audio/mpeg",
      size: 2048,
    });
    const rows = await findUploadedFiles(fileId);
    expect(rows[0]).toMatchObject({
      runId: fixture.runId,
      contentType: "audio/mpeg",
      filename: "clip.mp3",
    });
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const fixture = await seedRunFixture({});
    const fileId = randomUUID();
    mocks.s3.listObjects([s3Object(fixture.userId, fileId, "retry.txt", 7)]);

    const token = zeroToken(fixture);
    await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [200],
    );
    await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [200],
    );

    await expect(
      findUploadedFilesForRun(fixture.runId, fileId),
    ).resolves.toHaveLength(1);
  });

  it("returns 404 and does not record when the uploaded object cannot be found", async () => {
    const fixture = await seedRunFixture({});
    const fileId = randomUUID();
    mocks.s3.listObjects([]);

    const token = zeroToken(fixture);
    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Uploaded file not found", code: "NOT_FOUND" },
    });
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });

  it("rejects suspended orgs before completing the upload", async () => {
    const fixture = await seedRunFixture({});
    await seedOrgTier(fixture.orgId, "pro-suspend");
    const fileId = randomUUID();
    const token = zeroToken(fixture);

    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: fileId },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().complete({
        headers: {},
        body: { id: randomUUID() },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a zero token without file:write capability", async () => {
    const fixture = await seedRunFixture({});
    const token = zeroToken({
      ...fixture,
      capabilities: ["file:read"],
    });

    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: randomUUID() },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("file:write");
  });

  it("returns 400 when the request body is invalid", async () => {
    const fixture = await seedRunFixture({});
    const token = zeroToken(fixture);

    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: { id: "not-a-uuid" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request body", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 for unsupported content types", async () => {
    const fixture = await seedRunFixture({});
    const token = zeroToken(fixture);

    const response = await accept(
      apiClient().complete({
        headers: authHeaders(token),
        body: {
          id: randomUUID(),
          contentType: "application/x-msdownload",
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Unsupported file type: application/x-msdownload",
        code: "BAD_REQUEST",
      },
    });
  });
});
