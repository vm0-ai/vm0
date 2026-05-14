import { createHash, randomUUID } from "node:crypto";

import { cronCleanupSandboxesContract } from "@vm0/api-contracts/contracts/cron";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { exportJobs } from "@vm0/db/schema/export-job";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storage-bucket";
const FIXED_NOW_MS = Date.parse("2000-01-01T00:10:00.000Z");

interface RunFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly composeId: string;
  readonly versionId: string;
}

interface ExportJobFixture {
  readonly id: string;
}

function apiClient() {
  return setupApp({ context })(cronCleanupSandboxesContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function versionId(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function minutesAgo(minutes: number): Date {
  return new Date(FIXED_NOW_MS - minutes * 60 * 1000);
}

async function cleanupRunFixture(fixture: RunFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(agentRunQueue).where(eq(agentRunQueue.runId, fixture.runId));
  await db.delete(agentRuns).where(eq(agentRuns.id, fixture.runId));
  await db.delete(agentSessions).where(eq(agentSessions.id, fixture.sessionId));
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.id, fixture.versionId));
  await db.delete(agentComposes).where(eq(agentComposes.id, fixture.composeId));
}

async function cleanupExportJobFixture(
  fixture: ExportJobFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(exportJobs).where(eq(exportJobs.id, fixture.id));
}

async function insertRunFixture(args?: {
  readonly status?: string;
  readonly composeName?: string;
  readonly createdAt?: Date;
  readonly lastHeartbeatAt?: Date | null;
}): Promise<RunFixture> {
  const db = store.set(writeDb$);
  const userId = `user-${randomUUID()}`;
  const orgId = `org-${randomUUID()}`;
  const composeName = args?.composeName ?? `cleanup-${randomUUID()}`;
  const [compose] = await db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning({ id: agentComposes.id });
  if (!compose) {
    throw new Error("insertRunFixture: compose insert returned no row");
  }

  const id = versionId();
  await db.insert(agentComposeVersions).values({
    id,
    composeId: compose.id,
    createdBy: userId,
    content: { agents: {} },
  });
  await db
    .update(agentComposes)
    .set({ headVersionId: id })
    .where(eq(agentComposes.id, compose.id));

  const [session] = await db
    .insert(agentSessions)
    .values({
      userId,
      orgId,
      agentComposeId: compose.id,
      artifacts: [],
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("insertRunFixture: session insert returned no row");
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: id,
      sessionId: session.id,
      status: args?.status ?? "pending",
      prompt: "cleanup sandboxes test",
      sandboxId: `sandbox-${randomUUID()}`,
      createdAt: args?.createdAt,
      lastHeartbeatAt: args?.lastHeartbeatAt,
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("insertRunFixture: run insert returned no row");
  }

  return {
    runId: run.id,
    sessionId: session.id,
    composeId: compose.id,
    versionId: id,
  };
}

async function insertQueueEntry(
  fixture: RunFixture,
  expiresAt: Date,
): Promise<void> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, fixture.runId))
    .limit(1);
  if (!run) {
    throw new Error("insertQueueEntry: run not found");
  }

  await db.insert(agentRunQueue).values({
    runId: fixture.runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: run.createdAt,
    expiresAt,
  });
}

async function insertExportJob(args: {
  readonly status: string;
  readonly createdAt?: Date;
  readonly expiresAt?: Date | null;
  readonly s3Key?: string | null;
}): Promise<ExportJobFixture> {
  const db = store.set(writeDb$);
  const [job] = await db
    .insert(exportJobs)
    .values({
      userId: `user-${randomUUID()}`,
      orgId: `org-${randomUUID()}`,
      status: args.status,
      createdAt: args.createdAt,
      expiresAt: args.expiresAt,
      s3Key: args.s3Key,
    })
    .returning({ id: exportJobs.id });
  if (!job) {
    throw new Error("insertExportJob: insert returned no row");
  }
  return job;
}

async function findRun(runId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ status: agentRuns.status, error: agentRuns.error })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ?? null;
}

async function findExportJob(jobId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ status: exportJobs.status, error: exportJobs.error })
    .from(exportJobs)
    .where(eq(exportJobs.id, jobId))
    .limit(1);
  return row ?? null;
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

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Queued run expired (exceeded queue TTL)",
    });
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
