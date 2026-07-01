import { randomUUID } from "node:crypto";

import { cronCleanupSandboxesContract } from "@vm0/api-contracts/contracts/cron";
import type {
  TestCronCleanupSandboxesStateActionBody,
  TestCronCleanupSandboxesStateActionResponse,
} from "@vm0/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storage-bucket";
const FIXED_NOW_MS = Date.parse("2000-01-01T00:10:00.000Z");
const CRON_CLEANUP_STATE_ROUTE =
  "/api/test/cron-cleanup-sandboxes-state/action";

interface RunFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly orgId: string;
}

interface ExportJobFixture {
  readonly id: string;
}

interface QueueMarkerFixture {
  readonly markerId: string;
  readonly threadId: string;
}

interface QueueMarkerRevoker {
  readonly id: string;
  readonly revokesMessageId: string;
  readonly runEventId: string | null;
}

function apiClient() {
  return setupApp({ context })(cronCleanupSandboxesContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/cleanup-sandboxes", {
    method: "GET",
    headers,
  });
}

function minutesAgo(minutes: number): Date {
  return new Date(FIXED_NOW_MS - minutes * 60 * 1000);
}

function farFuture(): Date {
  return new Date("2999-01-01T00:00:00.000Z");
}

function requestCronCleanupState(
  body: TestCronCleanupSandboxesStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
  });
  return Promise.resolve(
    app.request(CRON_CLEANUP_STATE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function postCronCleanupState(
  body: TestCronCleanupSandboxesStateActionBody,
): Promise<TestCronCleanupSandboxesStateActionResponse> {
  const response = await requestCronCleanupState(body);
  if (!response.ok) {
    throw new Error(`cron cleanup state action failed with ${response.status}`);
  }
  return await readJson<TestCronCleanupSandboxesStateActionResponse>(response);
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`cron cleanup state response missing ${key}`);
  }
  return value;
}

function recordField(
  body: TestCronCleanupSandboxesStateActionResponse,
  key: string,
): Record<string, unknown> | null {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function cleanupRunFixture(fixture: RunFixture): Promise<void> {
  await postCronCleanupState({ action: "delete-run", run_id: fixture.runId });
}

async function cleanupExportJobFixture(
  fixture: ExportJobFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-export-job",
    export_job_id: fixture.id,
  });
}

async function insertRunFixture(args?: {
  readonly status?: string;
  readonly composeName?: string;
  readonly createdAt?: Date;
  readonly lastHeartbeatAt?: Date | null;
}): Promise<RunFixture> {
  const response = await postCronCleanupState({
    action: "seed-run",
    status: args?.status,
    compose_name: args?.composeName,
    created_at: args?.createdAt?.toISOString(),
    last_heartbeat_at:
      args?.lastHeartbeatAt === undefined
        ? undefined
        : (args.lastHeartbeatAt?.toISOString() ?? null),
  });
  return {
    runId: stringField(response, "run_id"),
    sessionId: stringField(response, "session_id"),
    composeId: stringField(response, "compose_id"),
    versionId: stringField(response, "version_id"),
    orgId: stringField(response, "org_id"),
  };
}

async function insertQueueEntry(
  fixture: RunFixture,
  expiresAt: Date,
  options?: {
    readonly encryptedParams?: string;
  },
): Promise<void> {
  await postCronCleanupState({
    action: "seed-queue-entry",
    run_id: fixture.runId,
    expires_at: expiresAt.toISOString(),
    encrypted_params: options?.encryptedParams,
  });
}

async function insertQueueMarker(
  fixture: RunFixture,
): Promise<QueueMarkerFixture> {
  const response = await postCronCleanupState({
    action: "seed-queue-marker",
    run_id: fixture.runId,
  });
  return {
    markerId: stringField(response, "marker_id"),
    threadId: stringField(response, "thread_id"),
  };
}

async function insertRunnerJobEntry(
  fixture: RunFixture,
  expiresAt: Date,
): Promise<void> {
  await postCronCleanupState({
    action: "seed-runner-job",
    run_id: fixture.runId,
    runner_group: "vm0/test",
    profile: "vm0/default",
    api_start_time: new Date(FIXED_NOW_MS).toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}

async function insertExportJob(args: {
  readonly status: string;
  readonly createdAt?: Date;
  readonly expiresAt?: Date | null;
  readonly s3Key?: string | null;
}): Promise<ExportJobFixture> {
  const response = await postCronCleanupState({
    action: "seed-export-job",
    status: args.status,
    created_at: args.createdAt?.toISOString(),
    expires_at:
      args.expiresAt === undefined
        ? undefined
        : (args.expiresAt?.toISOString() ?? null),
    s3_key: args.s3Key ?? undefined,
  });
  return { id: stringField(response, "export_job_id") };
}

async function findRun(runId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const response = await postCronCleanupState({
    action: "get-run",
    run_id: runId,
  });
  const row = recordField(response, "run");
  return row
    ? { status: stringField(row, "status"), error: nullableString(row.error) }
    : null;
}

async function findRunnerJob(runId: string): Promise<{
  readonly runId: string;
} | null> {
  const response = await postCronCleanupState({
    action: "get-runner-job",
    run_id: runId,
  });
  const row = recordField(response, "runner_job");
  return row ? { runId: stringField(row, "runId") } : null;
}

async function findQueueEntry(runId: string): Promise<{
  readonly runId: string;
} | null> {
  const response = await postCronCleanupState({
    action: "get-queue-entry",
    run_id: runId,
  });
  const row = recordField(response, "queue_entry");
  return row ? { runId: stringField(row, "runId") } : null;
}

async function findQueueMarkerRevoker(
  markerId: string,
): Promise<QueueMarkerRevoker | null> {
  const response = await postCronCleanupState({
    action: "get-queue-marker-revoker",
    marker_id: markerId,
  });
  const row = recordField(response, "queue_marker_revoker");
  return row
    ? {
        id: stringField(row, "id"),
        revokesMessageId: stringField(row, "revokesMessageId"),
        runEventId: nullableString(row.runEventId),
      }
    : null;
}

async function findExportJob(jobId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const response = await postCronCleanupState({
    action: "get-export-job",
    export_job_id: jobId,
  });
  const row = recordField(response, "export_job");
  return row
    ? { status: stringField(row, "status"), error: nullableString(row.error) }
    : null;
}

describe("GET /api/cron/cleanup-sandboxes", () => {
  const trackRun = createFixtureTracker<RunFixture>(cleanupRunFixture);
  const trackExportJob = createFixtureTracker<ExportJobFixture>(
    cleanupExportJobFixture,
  );

  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    mockNow(FIXED_NOW_MS);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with a missing authorization header", async () => {
    const response = await rawCronRequest();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("returns the cleanup result shape for an authorized request", async () => {
    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      cleaned: 0,
      errors: 0,
      results: [],
      exportJobsCleaned: 0,
      exportJobsStuck: 0,
    });
  });

  it("does not cleanup a recent pending run", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
    );
    await insertRunnerJobEntry(fixture, farFuture());

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "pending",
      error: null,
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toStrictEqual({
      runId: fixture.runId,
    });
  });

  it("does not cleanup a run with a recent heartbeat", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(1),
      }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  it("cleans up pending runs after the pending timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(6) }),
    );
    await insertRunnerJobEntry(fixture, farFuture());

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.results).toContainEqual(
      expect.objectContaining({
        runId: fixture.runId,
        status: "cleaned",
        reason: "Run timed out while pending (never started)",
      }),
    );
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();
  });

  it("cleans up pending runs without runner jobs after the pending timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(6) }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.results).toContainEqual(
      expect.objectContaining({
        runId: fixture.runId,
        status: "cleaned",
        reason: "Run timed out while pending (never started)",
      }),
    );
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { status: "failed" },
    );
  });

  it("deletes expired runner job queue entries", async () => {
    const expired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    const unexpired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    await insertRunnerJobEntry(expired, minutesAgo(1));
    await insertRunnerJobEntry(unexpired, farFuture());

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    await expect(findRunnerJob(expired.runId)).resolves.toBeNull();
    await expect(findRunnerJob(unexpired.runId)).resolves.toStrictEqual({
      runId: unexpired.runId,
    });
  });

  it("cleans up running runs after the heartbeat timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(3),
      }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.results).toContainEqual(
      expect.objectContaining({
        runId: fixture.runId,
        status: "cleaned",
        reason: "Run timed out (no heartbeat)",
      }),
    );
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out (no heartbeat)",
    });
  });

  it("does not cleanup completed runs even when they are old", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(60) }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
      error: null,
    });
  });

  it("cleans up multiple expired runs from different orgs", async () => {
    const firstFixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(6) }),
    );
    const secondFixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(7) }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(2);
    expect(response.body.results).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: firstFixture.runId,
          status: "cleaned",
        }),
        expect.objectContaining({
          runId: secondFixture.runId,
          status: "cleaned",
        }),
      ]),
    );
    await expect(findRun(firstFixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRun(secondFixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
  });

  it("keeps debug compose runs until the debug heartbeat timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        composeName: `debug-${randomUUID()}`,
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(30),
      }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  it("times out expired queued runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(130) }),
    );
    await insertQueueEntry(fixture, minutesAgo(1));

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.results).toContainEqual(
      expect.objectContaining({
        runId: fixture.runId,
        sandboxId: null,
        status: "cleaned",
        reason: "Queued run expired (exceeded queue TTL)",
      }),
    );
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Queued run expired (exceeded queue TTL)",
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { status: "failed" },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
  });

  it("cleans up queued runs missing queue entries after the grace threshold", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(6) }),
    );
    const marker = await insertQueueMarker(fixture);

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.results).toContainEqual(
      expect.objectContaining({
        runId: fixture.runId,
        sandboxId: null,
        status: "cleaned",
        reason: "Queued run timed out before queue entry was persisted",
      }),
    );
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Queued run timed out before queue entry was persisted",
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
    await expect(
      findQueueMarkerRevoker(marker.markerId),
    ).resolves.toMatchObject({
      revokesMessageId: marker.markerId,
      runEventId: "queue:dequeued",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      { status: "failed" },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${marker.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("does not clean up fresh queued runs missing queue entries", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(1) }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "queued",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `run:changed:${fixture.runId}`,
      expect.anything(),
    );
  });

  it("deletes expired stale queue entries without changing terminal runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "cancelled", createdAt: minutesAgo(130) }),
    );
    await insertQueueEntry(fixture, minutesAgo(1));

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
  });

  it("drains queued runs when an org has no active runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(1) }),
    );
    await insertQueueEntry(fixture, minutesAgo(-60));

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "pending",
      error: null,
    });
  });

  it("removes stale queue entries before decrypting queued payloads", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "cancelled", createdAt: minutesAgo(1) }),
    );
    await insertQueueEntry(fixture, minutesAgo(-60), {
      encryptedParams: "invalid-encrypted-payload",
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
  });

  it("cleans expired export jobs and fails stuck export jobs", async () => {
    const expiredJob = await trackExportJob(
      insertExportJob({
        status: "completed",
        createdAt: minutesAgo(30),
        expiresAt: minutesAgo(1),
        s3Key: "exports/expired.zip",
      }),
    );
    const stuckJob = await trackExportJob(
      insertExportJob({
        status: "running",
        createdAt: minutesAgo(11),
      }),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.exportJobsCleaned).toBe(1);
    expect(response.body.exportJobsStuck).toBe(1);
    await expect(findExportJob(expiredJob.id)).resolves.toBeNull();
    await expect(findExportJob(stuckJob.id)).resolves.toStrictEqual({
      status: "failed",
      error: "Export job timed out",
    });
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: BUCKET,
          Delete: {
            Objects: [{ Key: "exports/expired.zip" }],
          },
        }),
      }),
    );
  });
});
