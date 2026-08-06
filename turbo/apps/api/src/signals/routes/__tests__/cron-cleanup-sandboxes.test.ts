import { randomUUID } from "node:crypto";

import { cronCleanupSandboxesContract } from "@vm0/api-contracts/contracts/cron";
import {
  triggerSourceSchema,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import {
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE,
  runnersNetworkPolicyRefreshContract,
} from "@vm0/api-contracts/contracts/runners";
import type {
  TestCronCleanupSandboxesStateActionBody,
  TestCronCleanupSandboxesStateActionResponse,
} from "@vm0/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test as vitestTest,
} from "vitest";

import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import {
  holdAgentRunDeletionFixture,
  holdOrgCreditLockFixture,
  holdRunOutputProjectionLockFixture,
  insertPendingInlineDeliveryCallbackFixture,
  readRunCallbackFixture,
  withThreadlessRunCleanupTestLockFixture,
} from "../../../test-fixtures/run-deletion";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createFixtureTracker } from "./helpers/zero-route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { runnersRoutes } from "../runners";

const TEST_APP_ROUTES = Object.freeze([
  ...cronCleanupSandboxesRoutes,
  ...runnersRoutes,
]);

const context = testContext();
const webhooks = createWebhookCallbackApi(context);
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storage-bucket";
const FIXED_NOW_MS = Date.parse("2000-01-01T00:10:00.000Z");
const THREADLESS_FORWARD_CUTOFF_MS = Date.parse("2026-08-03T05:40:26.000Z");
const THREADLESS_TEST_NOW_MS = Date.parse("2026-08-03T06:00:00.000Z");
const NON_TEST_TRIGGER_SOURCES: readonly TriggerSource[] =
  triggerSourceSchema.options.filter((source) => {
    return source !== "test";
  });
const CRON_CLEANUP_STATE_ROUTE =
  "/api/test/cron-cleanup-sandboxes-state/action";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function it(name: string, test: () => Promise<void>, timeout?: number): void {
  vitestTest(
    name,
    async () => {
      await withThreadlessRunCleanupTestLockFixture({
        signal: context.signal,
        run: test,
      });
    },
    timeout,
  );
}

interface RunFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly orgId: string;
  readonly userId: string;
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
  readonly revokesEventId: string;
  readonly runEventId: string | null;
}

interface RunOwnershipFixture {
  readonly usageEventId: string;
  readonly uploadedFileId: string;
  readonly fileArtifactId: string;
  readonly browserSessionId: string;
  readonly generationJobId: string;
  readonly hostedSiteId: string;
  readonly hostedDeploymentId: string;
  readonly hostedArtifactId: string;
}

interface ChatThreadFixture {
  readonly threadId: string;
}

function apiClient() {
  return setupApp({ context, routes: cronCleanupSandboxesRoutes })(
    cronCleanupSandboxesContract,
  );
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
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
  await postCronCleanupState({
    action: "delete-run",
    run_id: fixture.runId,
    session_id: fixture.sessionId,
    compose_id: fixture.composeId,
    version_id: fixture.versionId,
    org_id: fixture.orgId,
  });
}

async function cleanupExportJobFixture(
  fixture: ExportJobFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-export-job",
    export_job_id: fixture.id,
  });
}

function ownershipActionFields(
  fixture: RunOwnershipFixture,
): Record<string, string> {
  return {
    usage_event_id: fixture.usageEventId,
    uploaded_file_id: fixture.uploadedFileId,
    file_artifact_id: fixture.fileArtifactId,
    browser_session_id: fixture.browserSessionId,
    generation_job_id: fixture.generationJobId,
    hosted_site_id: fixture.hostedSiteId,
    hosted_deployment_id: fixture.hostedDeploymentId,
    hosted_artifact_id: fixture.hostedArtifactId,
  };
}

async function cleanupRunOwnershipFixture(
  fixture: RunOwnershipFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-run-ownership",
    ...ownershipActionFields(fixture),
  });
}

async function cleanupChatThreadFixture(
  fixture: ChatThreadFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-run-thread",
    thread_id: fixture.threadId,
  });
}

async function insertRunFixture(args?: {
  readonly status?: string;
  readonly composeName?: string;
  readonly createdAt?: Date;
  readonly lastHeartbeatAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly cancellationRecoveryCompleted?: boolean;
  readonly threadless?: boolean;
  readonly triggerSource?: TriggerSource;
  readonly userId?: string;
  readonly orgId?: string;
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
    completed_at:
      args?.completedAt === undefined
        ? undefined
        : (args.completedAt?.toISOString() ?? null),
    cancellation_recovery_completed: args?.cancellationRecoveryCompleted,
    threadless: args?.threadless,
    trigger_source: args?.triggerSource,
    user_id: args?.userId,
    org_id: args?.orgId,
  });
  return {
    runId: stringField(response, "run_id"),
    sessionId: stringField(response, "session_id"),
    composeId: stringField(response, "compose_id"),
    versionId: stringField(response, "version_id"),
    orgId: stringField(response, "org_id"),
    userId: stringField(response, "user_id"),
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

async function insertRunOwnership(
  fixture: RunFixture,
): Promise<RunOwnershipFixture> {
  const response = await postCronCleanupState({
    action: "seed-run-ownership",
    run_id: fixture.runId,
  });
  return {
    usageEventId: stringField(response, "usage_event_id"),
    uploadedFileId: stringField(response, "uploaded_file_id"),
    fileArtifactId: stringField(response, "file_artifact_id"),
    browserSessionId: stringField(response, "browser_session_id"),
    generationJobId: stringField(response, "generation_job_id"),
    hostedSiteId: stringField(response, "hosted_site_id"),
    hostedDeploymentId: stringField(response, "hosted_deployment_id"),
    hostedArtifactId: stringField(response, "hosted_artifact_id"),
  };
}

async function attachRunThread(
  fixture: RunFixture,
): Promise<ChatThreadFixture> {
  const response = await postCronCleanupState({
    action: "attach-run-thread",
    run_id: fixture.runId,
  });
  return { threadId: stringField(response, "thread_id") };
}

async function findRunOwnership(
  fixture: RunOwnershipFixture,
): Promise<TestCronCleanupSandboxesStateActionResponse> {
  return await postCronCleanupState({
    action: "get-run-ownership",
    ...ownershipActionFields(fixture),
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

async function insertCustomConnectorAuthRef(
  fixture: RunFixture,
  secretName: string,
  expiresAt: Date,
): Promise<void> {
  await postCronCleanupState({
    action: "seed-custom-connector-auth-ref",
    run_id: fixture.runId,
    secret_name: secretName,
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

async function findCustomConnectorAuthRef(
  runId: string,
  secretName: string,
): Promise<{
  readonly runId: string;
} | null> {
  const response = await postCronCleanupState({
    action: "get-custom-connector-auth-ref",
    run_id: runId,
    secret_name: secretName,
  });
  const row = recordField(response, "custom_connector_auth_ref");
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
        revokesEventId: stringField(row, "revokesEventId"),
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
  const trackRunOwnership = createFixtureTracker<RunOwnershipFixture>(
    cleanupRunOwnershipFixture,
  );
  const trackChatThread = createFixtureTracker<ChatThreadFixture>(
    cleanupChatThreadFixture,
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
      threadlessRuns: {
        discovered: expect.any(Number),
        cancelled: expect.any(Number),
        waiting: expect.any(Number),
        deleted: expect.any(Number),
        failed: expect.any(Number),
        errors: expect.any(Array),
      },
    });
  });

  it("leaves the audited pre-forward threadless cohort discoverable", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS - 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );

    await accept(apiClient().cleanup({ headers: cronHeaders() }), [200]);

    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("ignores preview-only test fixture runs without bypassing non-test runs", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
        triggerSource: "test",
      }),
    );

    await accept(apiClient().cleanup({ headers: cronHeaders() }), [200]);

    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("processes every non-test trigger source when the run is threadless", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixtures: RunFixture[] = [];
    for (const triggerSource of NON_TEST_TRIGGER_SOURCES) {
      fixtures.push(
        await trackRun(
          insertRunFixture({
            status: "completed",
            createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
            completedAt: new Date(
              THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
            ),
            threadless: true,
            triggerSource,
          }),
        ),
      );
    }

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(
      NON_TEST_TRIGGER_SOURCES.length,
    );
    expect(response.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(
      NON_TEST_TRIGGER_SOURCES.length,
    );
    for (const fixture of fixtures) {
      await expect(findRun(fixture.runId)).resolves.toBeNull();
    }
  });

  it("waits through the quiet window and deletes at its exact boundary", async () => {
    const completedAt = new Date(THREADLESS_TEST_NOW_MS);
    mockNow(completedAt.getTime() + CANCELLATION_RECOVERY_STALE_AFTER_MS - 1);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt,
        threadless: true,
      }),
    );

    const waitingResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(
      waitingResponse.body.threadlessRuns.discovered,
    ).toBeGreaterThanOrEqual(1);
    expect(waitingResponse.body.threadlessRuns.waiting).toBeGreaterThanOrEqual(
      1,
    );
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();

    mockNow(completedAt.getTime() + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const deletedResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(
      deletedResponse.body.threadlessRuns.discovered,
    ).toBeGreaterThanOrEqual(1);
    expect(deletedResponse.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(
      1,
    );
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("hard-cancels an active threadless run without deleting it in the same pass", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: new Date(THREADLESS_TEST_NOW_MS - 60_000),
        lastHeartbeatAt: new Date(THREADLESS_TEST_NOW_MS - 60_000),
        threadless: true,
      }),
    );

    const cancelledResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(
      cancelledResponse.body.threadlessRuns.discovered,
    ).toBeGreaterThanOrEqual(1);
    expect(
      cancelledResponse.body.threadlessRuns.cancelled,
    ).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
    });

    mockNow(THREADLESS_TEST_NOW_MS + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const deletedResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(
      deletedResponse.body.threadlessRuns.discovered,
    ).toBeGreaterThanOrEqual(1);
    expect(deletedResponse.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(
      1,
    );
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("redrives expired unresolved cancellation recovery before deletion", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "cancelled",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS + 1,
        ),
        cancellationRecoveryCompleted: false,
        threadless: true,
      }),
    );

    const waiting = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(waiting.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(waiting.body.threadlessRuns.waiting).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();

    mockNow(THREADLESS_TEST_NOW_MS + 1);
    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(response.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(response.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("terminalizes a stranded inline delivery callback before deleting its run", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const callbackId = await insertPendingInlineDeliveryCallbackFixture(
      fixture.runId,
    );
    await insertRunnerJobEntry(fixture, new Date(0));

    const waiting = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(waiting.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(waiting.body.threadlessRuns.waiting).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();
    await expect(readRunCallbackFixture(callbackId)).resolves.toStrictEqual({
      status: "failed",
      lastError: "Chat thread was deleted before inline callback delivery",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();

    const deleted = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(deleted.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(deleted.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("cascades run-owned artifacts while preserving independent ownership", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const usageProvider = `cleanup-test-${fixture.runId}`;
    await seedUsagePricingRows([
      {
        kind: "model",
        provider: usageProvider,
        category: "tokens.input",
        unitPrice: 9,
        unitSize: 1,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: usageProvider,
        categories: ["tokens.input"],
      });
    });
    const ownership = await trackRunOwnership(insertRunOwnership(fixture));

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(response.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(1);
    const state = await findRunOwnership(ownership);
    expect(recordField(state, "uploaded_file")).toBeNull();
    expect(recordField(state, "file_artifact")).toBeNull();
    expect(recordField(state, "usage_event")).toMatchObject({
      runId: null,
      status: "processed",
      creditsCharged: 9,
    });
    expect(recordField(state, "browser_session")).toMatchObject({
      id: ownership.browserSessionId,
      runId: null,
    });
    expect(recordField(state, "generation_job")).toMatchObject({
      id: ownership.generationJobId,
      runId: null,
    });
    expect(recordField(state, "hosted_site")).toMatchObject({
      id: ownership.hostedSiteId,
      createdFromRunId: fixture.runId,
    });
    expect(recordField(state, "hosted_deployment")).toMatchObject({
      id: ownership.hostedDeploymentId,
      runId: fixture.runId,
    });
    expect(recordField(state, "hosted_artifact")).toStrictEqual({
      id: ownership.hostedArtifactId,
    });
  });

  it("processes only the oldest bounded batch of threadless runs", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const userId = `user-${randomUUID()}`;
    const orgId = `org-${randomUUID()}`;
    const fixtures = await Promise.all(
      Array.from({ length: 21 }, async (_, index) => {
        return await trackRun(
          insertRunFixture({
            status: "completed",
            createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + index + 1),
            completedAt: new Date(
              THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
            ),
            threadless: true,
            userId,
            orgId,
          }),
        );
      }),
    );

    const firstResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(firstResponse.body.threadlessRuns).toMatchObject({
      discovered: 20,
      deleted: 20,
      failed: 0,
    });
    await expect(findRun(fixtures[20]!.runId)).resolves.not.toBeNull();

    const secondResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(
      secondResponse.body.threadlessRuns.discovered,
    ).toBeGreaterThanOrEqual(1);
    expect(secondResponse.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(
      1,
    );
    await expect(findRun(fixtures[20]!.runId)).resolves.toBeNull();
  });

  it("acknowledges an event projection that loses the root-delete race", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const held = await holdRunOutputProjectionLockFixture({
      runId: fixture.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        fixture.runId,
        fixture.orgId,
      )}`,
    };
    const eventRequest = webhooks.requestAgentEvents(
      {
        runId: fixture.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: `msg_${randomUUID()}`,
              content: [{ type: "text", text: "late output" }],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    const cleanup = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(cleanup.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(cleanup.body.threadlessRuns.deleted).toBeGreaterThanOrEqual(1);
    held.release();
    await held.done;
    const eventResponse = await eventRequest;
    expect(eventResponse).toMatchObject({
      status: 200,
      body: { received: 1, firstSequence: 0, lastSequence: 0 },
    });
  });

  it("skips deletion when the threadless state changes before the write transaction", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const held = await holdOrgCreditLockFixture({
      orgId: fixture.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const cleanupRequest = apiClient().cleanup({ headers: cronHeaders() });
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    await trackChatThread(attachRunThread(fixture));
    held.release();
    await held.done;
    const cleanup = await accept(cleanupRequest, [200]);
    expect(cleanup.body.threadlessRuns.discovered).toBeGreaterThanOrEqual(1);
    expect(cleanup.body.threadlessRuns.waiting).toBeGreaterThanOrEqual(1);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("acknowledges completion when root deletion wins the row-lock race", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        threadless: true,
      }),
    );
    const held = await holdAgentRunDeletionFixture({
      runId: fixture.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        fixture.runId,
        fixture.orgId,
      )}`,
    };
    const completionRequest = webhooks.requestAgentComplete(
      {
        runId: fixture.runId,
        exitCode: 1,
        error: "late runner failure",
      },
      headers,
      [200],
    );
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    held.release();
    await held.done;
    const completion = await completionRequest;
    expect(completion).toMatchObject({
      status: 200,
      body: { success: true, status: "failed" },
    });
    await expect(findRun(fixture.runId)).resolves.toBeNull();
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

  it("exposes a pending-run timeout as terminal to policy refresh", async () => {
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

    const refresh = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersNetworkPolicyRefreshContract,
      ).refresh({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        params: { runId: fixture.runId },
        body: { connectorSlugs: ["slack"] },
      }),
      [409],
    );
    expect(refresh.body.error).toStrictEqual({
      code: NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE,
      message: "Run is terminal",
    });
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

  it("deletes expired custom connector auth refs", async () => {
    const expired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    const unexpired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    await insertCustomConnectorAuthRef(
      expired,
      "CUSTOM_EXPIRED_S_SECRET",
      minutesAgo(1),
    );
    await insertCustomConnectorAuthRef(
      unexpired,
      "CUSTOM_ACTIVE_S_SECRET",
      farFuture(),
    );

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(0);
    await expect(
      findCustomConnectorAuthRef(expired.runId, "CUSTOM_EXPIRED_S_SECRET"),
    ).resolves.toBeNull();
    await expect(
      findCustomConnectorAuthRef(unexpired.runId, "CUSTOM_ACTIVE_S_SECRET"),
    ).resolves.toStrictEqual({ runId: unexpired.runId });
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
      revokesEventId: marker.markerId,
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

  it("keeps queued timeout cleanup successful when queue realtime publish fails", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(6) }),
    );
    context.mocks.ably.publish.mockImplementation((topic) => {
      if (topic === "queue:changed") {
        return Promise.reject(new Error("queue realtime unavailable"));
      }
      return Promise.resolve();
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
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
