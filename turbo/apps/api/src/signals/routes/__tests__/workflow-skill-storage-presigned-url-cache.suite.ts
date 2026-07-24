import { randomUUID } from "node:crypto";

import { cronRefreshStoragePresignedUrlsContract } from "@vm0/api-contracts/contracts/cron";
import type {
  TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
  TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse,
} from "@vm0/api-contracts/contracts/test-workflow-skill-storage-presigned-url-cache-state";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { readStorageS3PrefixFixture } from "../../../test-fixtures/storage";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectLegacyStorageManifest,
} from "./helpers/api-bdd-runs";
import { cronRefreshStoragePresignedUrlsRoutes } from "../cron-refresh-storage-presigned-urls";
import { testWorkflowSkillStoragePresignedUrlCacheStateRoutes } from "../test-workflow-skill-storage-presigned-url-cache-state";

const context = testContext();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storages";
const WORKFLOW_CACHE_TTL_SECONDS = 2 * 60 * 60;
const WORKFLOW_CACHE_REFRESH_LIMIT = 32;
const ISOLATED_CACHE_CRON_NOW = Date.parse("2000-01-02T00:00:00.000Z");

interface CacheRow {
  readonly cache_key: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly storage_version_id: string;
  readonly resolved_org_id: string;
  readonly public_endpoint: boolean;
  readonly ttl_seconds: number;
  readonly presigned_url: string;
  readonly expires_at: string;
  readonly refresh_after: string;
  readonly last_requested_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateRequest(
  body: TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testWorkflowSkillStoragePresignedUrlCacheStateRoutes,
  });
  return Promise.resolve(
    app.request(
      "/api/test/workflow-skill-storage-presigned-url-cache-state/action",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function stateAction(
  body: TestWorkflowSkillStoragePresignedUrlCacheStateActionBody,
): Promise<TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse> {
  const response = await stateRequest(body);
  if (!response.ok) {
    throw new Error(`Workflow cache state action ${body.action} failed`);
  }
  return (await response.json()) as TestWorkflowSkillStoragePresignedUrlCacheStateActionResponse;
}

async function cleanupCacheState(objectKeyPrefix: string): Promise<void> {
  await stateAction({
    action: "cleanup",
    object_key_prefix: objectKeyPrefix,
  });
}

async function withCacheCleanup(
  objectKeyPrefix: string,
  run: () => Promise<void>,
): Promise<void> {
  await cleanupCacheState(objectKeyPrefix);
  await run().then(
    async () => {
      await cleanupCacheState(objectKeyPrefix);
    },
    async (error: unknown) => {
      await cleanupCacheState(objectKeyPrefix);
      throw error;
    },
  );
}

async function readCacheRowsByObjectKeyPrefix(
  objectKeyPrefix: string,
): Promise<readonly CacheRow[]> {
  const response = await stateAction({
    action: "read-cache-by-object-key-prefix",
    object_key_prefix: objectKeyPrefix,
  });
  return response.rows ?? [];
}

async function seedCacheRow(args: {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
  readonly refreshAfter: Date;
  readonly lastRequestedAt?: Date;
}): Promise<void> {
  await stateAction({
    action: "seed-cache-row",
    bucket: args.bucket,
    object_key: args.objectKey,
    storage_version_id: args.storageVersionId,
    resolved_org_id: args.resolvedOrgId,
    public_endpoint: true,
    ttl_seconds: WORKFLOW_CACHE_TTL_SECONDS,
    presigned_url: args.presignedUrl,
    expires_at: args.expiresAt.toISOString(),
    refresh_after: args.refreshAfter.toISOString(),
    ...(args.lastRequestedAt
      ? { last_requested_at: args.lastRequestedAt.toISOString() }
      : {}),
  });
}

function cronClient() {
  return setupAppWithRoutes({
    context,
    routes: cronRefreshStoragePresignedUrlsRoutes,
  })(cronRefreshStoragePresignedUrlsContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function mockUniquePresignedUrls(): void {
  let count = 0;
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      count += 1;
      const input = (command as { readonly input?: { readonly Key?: string } })
        .input;
      return Promise.resolve(
        `https://r2.example.com/${encodeURIComponent(input?.Key ?? "unknown")}?sig=${count}`,
      );
    },
  );
}

function apiDispatchTimingEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return (
        isRecord(event) &&
        event.run_id === runId &&
        typeof event.op_type === "string" &&
        event.op_type.startsWith("api_dispatch_")
      );
    });
  });
}

function singleApiDispatchEvent(
  events: readonly Record<string, unknown>[],
  opType: string,
): Record<string, unknown> {
  const matching = events.filter((event) => {
    return event.op_type === opType;
  });
  expect(matching).toHaveLength(1);
  const event = matching[0];
  if (!event) {
    throw new Error(`Missing timing event ${opType}`);
  }
  return event;
}

function expectTimingDoesNotLeak(
  events: readonly Record<string, unknown>[],
  values: readonly string[],
): void {
  const serialized = JSON.stringify(events);
  for (const value of values) {
    expect(serialized).not.toContain(value);
  }
}

async function entitledWorkflowActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  createMiscRoutesApi(context);
  const actor = bdd.user();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Workflow skill storage cache agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function createWorkflowSkillRunFixture(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly storageName: string;
  readonly objectKeyPrefix: string;
}> {
  const { actor, agentId, runnerGroup } = await entitledWorkflowActor();
  const workflowName = `cache-${randomUUID().slice(0, 8)}`;
  const misc = createMiscRoutesApi(context);
  const workflow = await misc.createWorkflow(
    actor,
    agentId,
    workflowName,
    {
      content: "# Cache test workflow\nUse this workflow for cache tests.",
    },
    [201],
  );
  if (workflow.status !== 201) {
    throw new Error("Expected workflow creation to succeed");
  }
  const workflowId = workflow.body.id;
  const storageName = getCustomSkillStorageName(workflowId);
  if (!actor.orgId) {
    throw new Error("Expected workflow cache test actor to have an org");
  }
  const objectKeyPrefix = await readStorageS3PrefixFixture({
    orgId: actor.orgId,
    userId: VOLUME_ORG_USER_ID,
    name: storageName,
  });
  return {
    actor,
    agentId,
    runnerGroup,
    workflowId,
    workflowName,
    storageName,
    objectKeyPrefix,
  };
}

async function createRunAndClaimWorkflowSkill(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly storageName: string;
  readonly prompt: string;
}): Promise<{
  readonly runId: string;
  readonly archiveUrl: string;
  readonly versionId: string;
}> {
  const api = createRunsApi(context);
  const run = await api.createRun(args.actor, {
    agentId: args.agentId,
    prompt: args.prompt,
    modelProvider: "anthropic-api-key",
  });
  await api.heartbeatRunner(args.runnerGroup);
  const claim = await api.claimRunnerJob(run.runId);
  const entry = expectLegacyStorageManifest(
    claim.storageManifest,
  )?.storages.find((storage) => {
    return storage.vasStorageName === args.storageName;
  });
  if (!entry) {
    throw new Error(
      `Missing workflow skill manifest entry ${args.storageName}`,
    );
  }
  return {
    runId: run.runId,
    archiveUrl: entry.archiveUrl,
    versionId: entry.vasVersionId,
  };
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockUniquePresignedUrls();
});

describe("workflow skill storage presigned URL cache", () => {
  it("reuses cached workflow skill storage URLs and throttles active touches", async () => {
    const fixture = await createWorkflowSkillRunFixture();
    await withCacheCleanup(fixture.objectKeyPrefix, async () => {
      mockUniquePresignedUrls();
      const first = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "warm the workflow skill URL cache",
      });

      const rowsAfterFirst = await readCacheRowsByObjectKeyPrefix(
        fixture.objectKeyPrefix,
      );
      expect(rowsAfterFirst).toHaveLength(1);
      const rowAfterFirst = rowsAfterFirst[0];
      if (!rowAfterFirst) {
        throw new Error("Expected workflow skill cache row");
      }
      expect(rowAfterFirst).toMatchObject({
        bucket: BUCKET,
        resolved_org_id: fixture.actor.orgId,
        storage_version_id: first.versionId,
        presigned_url: first.archiveUrl,
      });

      const firstTiming = apiDispatchTimingEventsForRun(first.runId);
      expect(
        singleApiDispatchEvent(
          firstTiming,
          "api_dispatch_prepare_storage_manifest_build_entries",
        ),
      ).toStrictEqual(
        expect.objectContaining({
          storage_manifest_source_workflow_skill_resolved_count_bucket: "1",
          storage_manifest_source_workflow_skill_planned_presign_count_bucket:
            "1",
          storage_manifest_source_workflow_skill_non_system_presign_count_bucket:
            "1",
          storage_manifest_workflow_skill_presign_cache_miss_count_bucket: "1",
          storage_manifest_workflow_skill_presign_cache_hit_count_bucket: "0",
        }),
      );
      const api = createRunsApi(context);
      await api.requestCancelRun(fixture.actor, first.runId, [200]);

      const touchedAt = new Date(
        Date.parse(rowAfterFirst.last_requested_at) + 31 * 60 * 1000,
      );
      mockNow(touchedAt);
      const second = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "reuse the workflow skill URL cache",
      });
      expect(second.archiveUrl).toBe(first.archiveUrl);
      const [rowAfterTouch] = await readCacheRowsByObjectKeyPrefix(
        fixture.objectKeyPrefix,
      );
      expect(rowAfterTouch?.last_requested_at).toBe(touchedAt.toISOString());

      const secondTiming = apiDispatchTimingEventsForRun(second.runId);
      expect(
        singleApiDispatchEvent(
          secondTiming,
          "api_dispatch_prepare_storage_manifest_build_entries",
        ),
      ).toStrictEqual(
        expect.objectContaining({
          storage_manifest_source_workflow_skill_resolved_count_bucket: "1",
          storage_manifest_source_workflow_skill_planned_presign_count_bucket:
            "0",
          storage_manifest_source_workflow_skill_non_system_presign_count_bucket:
            "0",
          storage_manifest_workflow_skill_presign_cache_hit_count_bucket: "1",
          storage_manifest_workflow_skill_presign_cache_miss_count_bucket: "0",
        }),
      );
      expectTimingDoesNotLeak(secondTiming, [
        fixture.workflowName,
        fixture.workflowId,
        fixture.agentId,
        fixture.objectKeyPrefix,
        second.archiveUrl,
      ]);
      await api.requestCancelRun(fixture.actor, second.runId, [200]);

      mockNow(touchedAt.getTime() + 10 * 60 * 1000);
      const third = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "reuse the recently touched workflow skill URL cache",
      });
      expect(third.archiveUrl).toBe(first.archiveUrl);
      const [rowWithinTouchInterval] = await readCacheRowsByObjectKeyPrefix(
        fixture.objectKeyPrefix,
      );
      expect(rowWithinTouchInterval?.last_requested_at).toBe(
        touchedAt.toISOString(),
      );

      await api.requestCancelRun(fixture.actor, third.runId, [200]);
    });
  });

  it("reuses stale safe rows and sync-refreshes unsafe rows", async () => {
    const fixture = await createWorkflowSkillRunFixture();
    const api = createRunsApi(context);
    await withCacheCleanup(fixture.objectKeyPrefix, async () => {
      const initial = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "create the workflow skill cache row",
      });
      const [cacheRow] = await readCacheRowsByObjectKeyPrefix(
        fixture.objectKeyPrefix,
      );
      if (!cacheRow) {
        throw new Error("Expected workflow skill cache row");
      }
      await api.requestCancelRun(fixture.actor, initial.runId, [200]);

      const now = nowDate();
      const staleUrl = "https://r2.example.com/stale-workflow-skill-url";
      await seedCacheRow({
        bucket: BUCKET,
        objectKey: cacheRow.object_key,
        storageVersionId: initial.versionId,
        resolvedOrgId: fixture.actor.orgId ?? "",
        presignedUrl: staleUrl,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        refreshAfter: new Date(now.getTime() - 60 * 1000),
        lastRequestedAt: now,
      });

      const staleRun = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "reuse stale but safe workflow skill URL",
      });
      expect(staleRun.archiveUrl).toBe(staleUrl);
      expect(
        singleApiDispatchEvent(
          apiDispatchTimingEventsForRun(staleRun.runId),
          "api_dispatch_prepare_storage_manifest_build_entries",
        ),
      ).toStrictEqual(
        expect.objectContaining({
          storage_manifest_workflow_skill_presign_cache_stale_reuse_count_bucket:
            "1",
          storage_manifest_source_workflow_skill_planned_presign_count_bucket:
            "0",
        }),
      );
      await api.requestCancelRun(fixture.actor, staleRun.runId, [200]);

      const unsafeUrl = "https://r2.example.com/unsafe-workflow-skill-url";
      await seedCacheRow({
        bucket: BUCKET,
        objectKey: cacheRow.object_key,
        storageVersionId: initial.versionId,
        resolvedOrgId: fixture.actor.orgId ?? "",
        presignedUrl: unsafeUrl,
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        refreshAfter: new Date(now.getTime() - 60 * 1000),
        lastRequestedAt: now,
      });

      const refreshedRun = await createRunAndClaimWorkflowSkill({
        ...fixture,
        prompt: "refresh unsafe workflow skill URL",
      });
      expect(refreshedRun.archiveUrl).not.toBe(unsafeUrl);
      expect(refreshedRun.archiveUrl).toContain("?sig=");
      expect(
        singleApiDispatchEvent(
          apiDispatchTimingEventsForRun(refreshedRun.runId),
          "api_dispatch_prepare_storage_manifest_build_entries",
        ),
      ).toStrictEqual(
        expect.objectContaining({
          storage_manifest_workflow_skill_presign_cache_sync_refresh_count_bucket:
            "1",
          storage_manifest_source_workflow_skill_planned_presign_count_bucket:
            "1",
          storage_manifest_source_workflow_skill_non_system_presign_count_bucket:
            "1",
        }),
      );
      await api.requestCancelRun(fixture.actor, refreshedRun.runId, [200]);
    });
  });

  it("refreshes bounded active cache rows and prunes inactive expired rows from cron", async () => {
    mockNow(ISOLATED_CACHE_CRON_NOW);
    const prefix = `org_${randomUUID()}/volume/workflow-cache-cron-${randomUUID()}`;
    await withCacheCleanup(prefix, async () => {
      const now = nowDate();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const expiredAt = new Date(now.getTime() - 60 * 60 * 1000);
      const refreshAfter = new Date(now.getTime() - 60 * 1000);
      const inactiveRequestedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      const activeRowCount = WORKFLOW_CACHE_REFRESH_LIMIT + 2;
      for (let index = 0; index < activeRowCount; index += 1) {
        const versionId = index.toString(36).padStart(2, "0").repeat(32);
        await seedCacheRow({
          bucket: BUCKET,
          objectKey: `${prefix}/${versionId}/archive.tar.gz`,
          storageVersionId: versionId,
          resolvedOrgId: "org_workflow_cache_cron",
          presignedUrl: `https://r2.example.com/active-old-${index}`,
          expiresAt,
          refreshAfter: new Date(refreshAfter.getTime() + index),
          lastRequestedAt: now,
        });
      }

      const inactiveFreshVersionId = "f".repeat(64);
      await seedCacheRow({
        bucket: BUCKET,
        objectKey: `${prefix}/${inactiveFreshVersionId}/archive.tar.gz`,
        storageVersionId: inactiveFreshVersionId,
        resolvedOrgId: "org_workflow_cache_cron",
        presignedUrl: "https://r2.example.com/inactive-fresh-old",
        expiresAt,
        refreshAfter,
        lastRequestedAt: inactiveRequestedAt,
      });

      for (let index = 0; index < 2; index += 1) {
        const versionId = `p${index}`.repeat(32).slice(0, 64);
        await seedCacheRow({
          bucket: BUCKET,
          objectKey: `${prefix}/${versionId}/archive.tar.gz`,
          storageVersionId: versionId,
          resolvedOrgId: "org_workflow_cache_cron",
          presignedUrl: `https://r2.example.com/inactive-expired-${index}`,
          expiresAt: expiredAt,
          refreshAfter,
          lastRequestedAt: inactiveRequestedAt,
        });
      }

      await accept(
        cronClient().refresh({ headers: cronHeaders("wrong") }),
        [401],
      );
      const firstTick = await accept(
        cronClient().refresh({ headers: cronHeaders() }),
        [200],
      );
      expect(firstTick.body).toStrictEqual({
        success: true,
        system: expect.objectContaining({
          due: expect.any(Number),
          refreshed: expect.any(Number),
          pruned: expect.any(Number),
        }),
        workflowSkill: {
          due: WORKFLOW_CACHE_REFRESH_LIMIT + 1,
          refreshed: WORKFLOW_CACHE_REFRESH_LIMIT,
          pruned: 2,
        },
      });

      const rowsAfterFirstTick = await readCacheRowsByObjectKeyPrefix(prefix);
      expect(
        rowsAfterFirstTick.filter((row) => {
          return row.presigned_url.includes("?sig=");
        }),
      ).toHaveLength(WORKFLOW_CACHE_REFRESH_LIMIT);

      const secondTick = await accept(
        cronClient().refresh({ headers: cronHeaders() }),
        [200],
      );
      expect(secondTick.body.workflowSkill).toStrictEqual({
        due: 2,
        refreshed: 2,
        pruned: 0,
      });

      const rows = await readCacheRowsByObjectKeyPrefix(prefix);
      expect(rows).toHaveLength(activeRowCount + 1);
      expect(
        rows.filter((row) => {
          return row.presigned_url.includes("?sig=");
        }),
      ).toHaveLength(activeRowCount);
      expect(
        rows.find((row) => {
          return row.storage_version_id === inactiveFreshVersionId;
        })?.presigned_url,
      ).toBe("https://r2.example.com/inactive-fresh-old");
    });
  });
});
