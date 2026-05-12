import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { userExportContract } from "@vm0/api-contracts/contracts/user-export";
import { exportJobs } from "@vm0/db/schema/export-job";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
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

type ExportJobStatus = "pending" | "running" | "completed" | "failed";

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

function client() {
  return setupApp({ context })(userExportContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
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

function signIn(userId: string, orgId = `org_${randomUUID()}`): void {
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
