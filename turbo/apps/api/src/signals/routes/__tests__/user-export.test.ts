import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import {
  userExportContract,
  type UserExportStartResponse,
} from "@vm0/api-contracts/contracts/user-export";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { exportJobs } from "@vm0/db/schema/export-job";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const NOW_ISO = "2026-05-12T05:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface ExportJobFixture {
  readonly id: string;
}

interface UserFixture {
  readonly userId: string;
  readonly email: string;
}

type ExportJobStatus = "pending" | "running" | "completed" | "failed";
type UserExportPostResponse =
  | { readonly status: 202; readonly body: UserExportStartResponse }
  | { readonly status: 401; readonly body: ApiErrorResponse }
  | { readonly status: 403; readonly body: ApiErrorResponse }
  | { readonly status: 429; readonly body: ApiErrorResponse }
  | { readonly status: 500; readonly body: ApiErrorResponse };

interface SeedExportJobArgs {
  readonly userId: string;
  readonly orgId?: string;
  readonly status: ExportJobStatus;
  readonly createdAt?: Date;
  readonly completedAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly s3Key?: string | null;
  readonly error?: string | null;
}

const track = createFixtureTracker<ExportJobFixture>(async (fixture) => {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(exportJobs).where(eq(exportJobs.id, fixture.id));
});

const trackUser = createFixtureTracker<UserFixture>(async (fixture) => {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(emailOutbox)
    .where(eq(emailOutbox.toAddresses, fixture.email));
  await writeDb.delete(userCache).where(eq(userCache.userId, fixture.userId));
  await writeDb.delete(users).where(eq(users.id, fixture.userId));
});

function client() {
  return setupApp({ context })(userExportContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function postExport<TStatus extends UserExportPostResponse["status"]>(
  headers: { readonly authorization?: string },
  statuses: readonly TStatus[],
): Promise<Extract<UserExportPostResponse, { readonly status: TStatus }>> {
  return accept(
    client().post({
      headers,
    }) as Promise<UserExportPostResponse>,
    statuses,
  );
}

function completedAtWithinCooldown(): Date {
  return new Date(NOW_MS - 60 * 60 * 1000);
}

function completedAtAfterCooldown(): Date {
  return new Date(NOW_MS - 25 * 60 * 60 * 1000);
}

function futureExpiresAt(): Date {
  return new Date(NOW_MS + 60 * 60 * 1000);
}

function pastExpiresAt(): Date {
  return new Date(NOW_MS - 60 * 60 * 1000);
}

async function seedExportJob(
  args: SeedExportJobArgs,
): Promise<ExportJobFixture> {
  const id = randomUUID();
  const writeDb = store.set(writeDb$);
  await writeDb.insert(exportJobs).values({
    id,
    userId: args.userId,
    orgId: args.orgId ?? `org_${randomUUID()}`,
    status: args.status,
    createdAt: args.createdAt ?? new Date(NOW_MS),
    completedAt: args.completedAt ?? null,
    expiresAt: args.expiresAt ?? null,
    s3Key: args.s3Key ?? null,
    error: args.error ?? null,
  });
  return { id };
}

async function seedUserEmail(
  userId: string,
  options: { readonly unsubscribed?: boolean } = {},
): Promise<UserFixture> {
  const email = `${userId}@example.com`;
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userCache)
    .values({
      userId,
      email,
      cachedAt: new Date(NOW_MS),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email, cachedAt: new Date(NOW_MS) },
    });
  await writeDb
    .insert(users)
    .values({
      id: userId,
      emailUnsubscribed: options.unsubscribed ?? false,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        emailUnsubscribed: options.unsubscribed ?? false,
        updatedAt: new Date(NOW_MS),
      },
    });

  return { userId, email };
}

async function getExportJob(id: string) {
  const writeDb = store.set(writeDb$);
  const [job] = await writeDb
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id))
    .limit(1);
  return job;
}

async function getExportReadyEmail(email: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.toAddresses, email))
    .limit(1);
  return row;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function signIn(
  userId: string,
  orgId: string | null = `org_${randomUUID()}`,
): void {
  mocks.clerk.session(userId, orgId);
}

beforeEach(() => {
  mockNow(NOW_MS);
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/export.zip?sig=test",
  );
});

describe("GET /api/user/export", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(client().get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      },
    });
  });

  it("returns null job and allows export when the user has no previous exports", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      job: null,
      canExport: true,
      nextExportAt: null,
    });
  });

  it("returns a completed non-expired export with a fresh download URL", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);
    const completedAt = completedAtWithinCooldown();
    const job = await track(
      seedExportJob({
        userId,
        status: "completed",
        completedAt,
        expiresAt: futureExpiresAt(),
        s3Key: `exports/${userId}/data.zip`,
      }),
    );

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      job: {
        id: job.id,
        status: "completed",
        createdAt: NOW_ISO,
        completedAt: completedAt.toISOString(),
        expiresAt: futureExpiresAt().toISOString(),
        downloadUrl: "https://r2.example.com/export.zip?sig=test",
        error: null,
      },
      canExport: false,
      nextExportAt: new Date(
        completedAt.getTime() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    const command = context.mocks.s3.getSignedUrl.mock.calls[0]?.[1] as
      | { input: Record<string, unknown> }
      | undefined;
    expect(command?.input).toMatchObject({
      Bucket: "test-user-storages",
      Key: `exports/${userId}/data.zip`,
      ResponseContentDisposition: 'attachment; filename="vm0-data-export.zip"',
    });
  });

  it("returns an active pending export and disallows new exports", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);
    const job = await track(seedExportJob({ userId, status: "pending" }));

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      job: {
        id: job.id,
        status: "pending",
        createdAt: NOW_ISO,
        completedAt: null,
        expiresAt: null,
        downloadUrl: null,
        error: null,
      },
      canExport: false,
      nextExportAt: null,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("allows export after the completed export cooldown expires", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);
    const completedAt = completedAtAfterCooldown();
    await track(
      seedExportJob({
        userId,
        status: "completed",
        completedAt,
        expiresAt: futureExpiresAt(),
        s3Key: `exports/${userId}/old.zip`,
      }),
    );

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.canExport).toBeTruthy();
    expect(response.body.nextExportAt).toBeNull();
    expect(response.body.job?.downloadUrl).toBe(
      "https://r2.example.com/export.zip?sig=test",
    );
  });

  it("returns a failed export with its error and allows new exports", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);
    const job = await track(
      seedExportJob({
        userId,
        status: "failed",
        error: "S3 upload failed",
      }),
    );

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      job: {
        id: job.id,
        status: "failed",
        createdAt: NOW_ISO,
        completedAt: null,
        expiresAt: null,
        downloadUrl: null,
        error: "S3 upload failed",
      },
      canExport: true,
      nextExportAt: null,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("does not generate a download URL for an expired completed export", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId);
    await track(
      seedExportJob({
        userId,
        status: "completed",
        completedAt: completedAtWithinCooldown(),
        expiresAt: pastExpiresAt(),
        s3Key: `exports/${userId}/expired.zip`,
      }),
    );

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.job?.downloadUrl).toBeNull();
    expect(response.body.canExport).toBeFalsy();
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("uses only the authenticated user's latest export job", async () => {
    const userId = `user_${randomUUID()}`;
    const otherUserId = `user_${randomUUID()}`;
    signIn(userId);
    const ownJob = await track(
      seedExportJob({
        userId,
        status: "running",
        createdAt: new Date(NOW_MS - 60_000),
      }),
    );
    await track(
      seedExportJob({
        userId: otherUserId,
        status: "completed",
        createdAt: new Date(NOW_MS),
        completedAt: completedAtWithinCooldown(),
        expiresAt: futureExpiresAt(),
        s3Key: `exports/${otherUserId}/data.zip`,
      }),
    );

    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.job?.id).toBe(ownJob.id);
    expect(response.body.job?.status).toBe("running");
    expect(response.body.canExport).toBeFalsy();
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/export", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await postExport({}, [401]);

    expect(response.body).toStrictEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      },
    });
  });

  it("returns 401 when the session has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    signIn(userId, null);

    const response = await postExport(authHeaders(), [401]);

    expect(response.body).toStrictEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      },
    });
  });

  it("returns an active export job without creating a second one", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    signIn(userId, orgId);
    const job = await track(
      seedExportJob({ userId, orgId, status: "running" }),
    );

    const response = await postExport(authHeaders(), [202]);

    expect(response.body).toStrictEqual({
      jobId: job.id,
      status: "running",
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns 429 when a completed export is still in cooldown", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    signIn(userId, orgId);
    await track(
      seedExportJob({
        userId,
        orgId,
        status: "completed",
        completedAt: completedAtWithinCooldown(),
      }),
    );

    const response = await postExport(authHeaders(), [429]);

    expect(response.body).toStrictEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Export already completed within the last 24 hours",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("creates and completes an export job", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const user = await trackUser(seedUserEmail(userId));
    signIn(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/data-export.zip?sig=test",
    );

    const response = await postExport(authHeaders(), [202]);
    await track(Promise.resolve({ id: response.body.jobId }));

    expect(response.body.status).toBe("pending");

    await clearAllDetached();

    const job = await getExportJob(response.body.jobId);
    expect(job).toMatchObject({
      id: response.body.jobId,
      userId,
      orgId,
      status: "completed",
      s3Key: `exports/${userId}/${response.body.jobId}.zip`,
      error: null,
    });
    expect(job?.completedAt?.toISOString()).toBe(NOW_ISO);
    expect(job?.expiresAt?.toISOString()).toBe(
      new Date(NOW_MS + 72 * 60 * 60 * 1000).toISOString(),
    );

    const putInput = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command);
      })
      .find((input) => {
        return input.Key === `exports/${userId}/${response.body.jobId}.zip`;
      });
    expect(putInput).toMatchObject({
      Bucket: "test-user-storages",
      ContentType: "application/zip",
    });
    expect(putInput?.Body).toBeInstanceOf(Buffer);

    const email = await getExportReadyEmail(user.email);
    expect(email).toMatchObject({
      fromAddress: "Zero <vm0@mail.example.com>",
      toAddresses: user.email,
      subject: "Your data export is ready",
      status: "pending",
      attempts: 0,
    });
    expect(email?.headers).toMatchObject({
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(email?.template).toMatchObject({
      template: "data-export-ready",
      props: {
        downloadUrl: "https://r2.example.com/data-export.zip?sig=test",
        expiresAt: "May 15, 2026",
        artifactCount: 0,
      },
    });
  });

  it("marks the export job failed when execution fails", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await trackUser(seedUserEmail(userId));
    signIn(userId, orgId);
    context.mocks.s3.send.mockRejectedValueOnce(new Error("S3 upload failed"));

    const response = await postExport(authHeaders(), [202]);
    await track(Promise.resolve({ id: response.body.jobId }));
    await clearAllDetached();

    const job = await getExportJob(response.body.jobId);
    expect(job).toMatchObject({
      id: response.body.jobId,
      status: "failed",
      error: "S3 upload failed",
    });
    await expect(
      getExportReadyEmail(`${userId}@example.com`),
    ).resolves.toBeUndefined();
  });

  it("skips the completion email when the user is unsubscribed", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const user = await trackUser(seedUserEmail(userId, { unsubscribed: true }));
    signIn(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const response = await postExport(authHeaders(), [202]);
    await track(Promise.resolve({ id: response.body.jobId }));
    await clearAllDetached();

    const job = await getExportJob(response.body.jobId);
    expect(job?.status).toBe("completed");
    await expect(getExportReadyEmail(user.email)).resolves.toBeUndefined();
  });
});
