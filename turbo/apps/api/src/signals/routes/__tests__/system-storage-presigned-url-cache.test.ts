import { randomUUID } from "node:crypto";

import { cronRefreshSystemStoragePresignedUrlsContract } from "@vm0/api-contracts/contracts/cron";
import type {
  TestSystemStoragePresignedUrlCacheStateActionBody,
  TestSystemStoragePresignedUrlCacheStateActionResponse,
} from "@vm0/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { resolveSkillRef } from "@vm0/core/github-url";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { cronRefreshSystemStoragePresignedUrlsRoutes } from "../cron-refresh-system-storage-presigned-urls";

const context = testContext();
const CRON_SECRET = "test-cron-secret";
const BUCKET = "test-user-storages";

interface CacheRow {
  readonly cache_key: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly storage_version_id: string;
  readonly public_endpoint: boolean;
  readonly ttl_seconds: number;
  readonly presigned_url: string;
  readonly expires_at: string;
  readonly refresh_after: string;
  readonly last_requested_at: string;
}

interface StorageState {
  readonly s3_prefix: string;
  readonly size: number;
  readonly file_count: number;
  readonly head_version_id: string | null;
}

function stateRequest(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  });
  return Promise.resolve(
    app.request("/api/test/system-storage-presigned-url-cache-state/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function stateAction(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
): Promise<TestSystemStoragePresignedUrlCacheStateActionResponse> {
  const response = await stateRequest(body);
  if (!response.ok) {
    throw new Error(`Cache state action ${body.action} failed`);
  }
  return (await response.json()) as TestSystemStoragePresignedUrlCacheStateActionResponse;
}

async function cleanupCacheState(args: {
  readonly objectKeyPrefix: string;
}): Promise<void> {
  await stateAction({
    action: "cleanup",
    object_key_prefix: args.objectKeyPrefix,
  });
}

async function withCacheCleanup(
  args: {
    readonly objectKeyPrefix: string;
  },
  run: () => Promise<void>,
): Promise<void> {
  await cleanupCacheState(args);
  await run().then(
    async () => {
      await cleanupCacheState(args);
    },
    async (error: unknown) => {
      await cleanupCacheState(args);
      throw error;
    },
  );
}

async function readStorageState(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storageName: string;
}): Promise<StorageState | null> {
  const response = await stateAction({
    action: "read-storage-state",
    org_id: args.orgId,
    user_id: args.userId,
    storage_name: args.storageName,
  });
  return response.storage_state ?? null;
}

async function restoreStorageState(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storageName: string;
  readonly previous: StorageState | null;
}): Promise<void> {
  await stateAction({
    action: "restore-storage-state",
    org_id: args.orgId,
    user_id: args.userId,
    storage_name: args.storageName,
    previous: args.previous,
  });
}

async function withStorageStateRestore(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly storageName: string;
    readonly cleanupVersionId?: string;
  },
  run: () => Promise<void>,
): Promise<void> {
  const previous = await readStorageState(args);
  await run().then(
    async () => {
      await restoreStorageState({ ...args, previous });
      if (args.cleanupVersionId) {
        await deleteStorageVersion({
          ...args,
          versionId: args.cleanupVersionId,
        });
      }
    },
    async (error: unknown) => {
      await restoreStorageState({ ...args, previous });
      if (args.cleanupVersionId) {
        await deleteStorageVersion({
          ...args,
          versionId: args.cleanupVersionId,
        });
      }
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

async function seedStorageVersion(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
}): Promise<void> {
  await stateAction({
    action: "seed-storage-version",
    org_id: args.orgId,
    user_id: args.userId,
    storage_name: args.storageName,
    version_id: args.versionId,
    s3_prefix: args.s3Prefix,
    s3_key: args.s3Key,
  });
}

async function deleteStorageVersion(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storageName: string;
  readonly versionId: string;
}): Promise<void> {
  await stateAction({
    action: "delete-storage-version",
    org_id: args.orgId,
    user_id: args.userId,
    storage_name: args.storageName,
    version_id: args.versionId,
  });
}

async function seedCacheRow(args: {
  readonly bucket: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
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
    public_endpoint: true,
    ttl_seconds: 2 * 60 * 60,
    presigned_url: args.presignedUrl,
    expires_at: args.expiresAt.toISOString(),
    refresh_after: args.refreshAfter.toISOString(),
    ...(args.lastRequestedAt
      ? { last_requested_at: args.lastRequestedAt.toISOString() }
      : {}),
  });
}

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsAutomationsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "System storage cache agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
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

function firstSeedSkillStorage() {
  const skillName = SEED_SKILLS[0];
  if (!skillName) {
    throw new Error("Expected at least one seed skill");
  }
  const skillRef = resolveSkillRef(skillName);
  const fullPath = skillRef.replace("https://github.com/", "");
  const storageName = getSkillStorageName(fullPath);
  const versionId = randomUUID()
    .replaceAll("-", "")
    .padEnd(64, "a")
    .slice(0, 64);
  const s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`;
  const s3Key = `${s3Prefix}/${versionId}`;
  return { skillName, storageName, versionId, s3Prefix, s3Key };
}

function cronClient() {
  return setupAppWithRoutes({
    context,
    routes: cronRefreshSystemStoragePresignedUrlsRoutes,
  })(cronRefreshSystemStoragePresignedUrlsContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockUniquePresignedUrls();
});

describe("system storage presigned URL cache", () => {
  it("reuses cached system-owned storage URLs across Zero runs", async () => {
    const api = createRunsAutomationsApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    mockUniquePresignedUrls();
    const skill = firstSeedSkillStorage();
    await withCacheCleanup(
      {
        objectKeyPrefix: skill.s3Prefix,
      },
      async () => {
        await withStorageStateRestore(
          {
            orgId: SYSTEM_ORG_ID,
            userId: VOLUME_ORG_USER_ID,
            storageName: skill.storageName,
            cleanupVersionId: skill.versionId,
          },
          async () => {
            await seedStorageVersion({
              orgId: SYSTEM_ORG_ID,
              userId: VOLUME_ORG_USER_ID,
              storageName: skill.storageName,
              versionId: skill.versionId,
              s3Prefix: skill.s3Prefix,
              s3Key: skill.s3Key,
            });

            const firstRun = await api.createRun(actor, {
              agentId,
              prompt: "warm the system storage URL cache",
              modelProvider: "anthropic-api-key",
            });
            await api.heartbeatRunner(runnerGroup);
            const firstClaim = await api.claimRunnerJob(firstRun.runId);
            const firstSkillEntry = firstClaim.storageManifest?.storages.find(
              (storage) => {
                return storage.vasStorageName === skill.storageName;
              },
            );
            expect(firstSkillEntry?.archiveUrl).toContain(skill.versionId);

            const rowsAfterFirst = await readCacheRowsByObjectKeyPrefix(
              skill.s3Prefix,
            );
            expect(rowsAfterFirst).toHaveLength(1);
            expect(rowsAfterFirst[0]?.presigned_url).toBe(
              firstSkillEntry?.archiveUrl,
            );

            const secondRun = await api.createRun(actor, {
              agentId,
              prompt: "reuse the system storage URL cache",
              modelProvider: "anthropic-api-key",
            });
            await api.heartbeatRunner(runnerGroup);
            const secondClaim = await api.claimRunnerJob(secondRun.runId);
            const secondSkillEntry = secondClaim.storageManifest?.storages.find(
              (storage) => {
                return storage.vasStorageName === skill.storageName;
              },
            );

            expect(secondSkillEntry?.archiveUrl).toBe(
              firstSkillEntry?.archiveUrl,
            );
            await api.requestCancelRun(actor, firstRun.runId, [200]);
            await api.requestCancelRun(actor, secondRun.runId, [200]);
          },
        );
      },
    );
  });

  it("refreshes only a bounded due cache batch from cron", async () => {
    const prefix = `${SYSTEM_ORG_ID}/volume/cache-cron-${randomUUID()}`;
    await withCacheCleanup(
      {
        objectKeyPrefix: prefix,
      },
      async () => {
        const now = nowDate();
        const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        const refreshAfter = new Date(now.getTime() - 60 * 1000);

        for (let index = 0; index < 5; index += 1) {
          const versionId = `${index}`.repeat(64).slice(0, 64);
          await seedCacheRow({
            bucket: BUCKET,
            objectKey: `${prefix}/${versionId}/archive.tar.gz`,
            storageVersionId: versionId,
            presignedUrl: `https://r2.example.com/old-${index}`,
            expiresAt,
            refreshAfter: new Date(refreshAfter.getTime() + index),
            lastRequestedAt: now,
          });
        }

        await accept(
          cronClient().refresh({ headers: cronHeaders("wrong") }),
          [401],
        );
        const refreshed = await accept(
          cronClient().refresh({ headers: cronHeaders() }),
          [200],
        );
        expect(refreshed.body).toStrictEqual({
          success: true,
          due: 3,
          refreshed: 3,
          pruned: 0,
        });

        const rows = await readCacheRowsByObjectKeyPrefix(prefix);
        expect(rows).toHaveLength(5);
        expect(
          rows.filter((row) => {
            return row.presigned_url.includes("?sig=");
          }),
        ).toHaveLength(3);
        expect(
          rows.filter((row) => {
            return row.presigned_url.includes("/old-");
          }),
        ).toHaveLength(2);
      },
    );
  });

  it("skips inactive due cache rows in cron", async () => {
    const prefix = `${SYSTEM_ORG_ID}/volume/cache-inactive-${randomUUID()}`;
    await withCacheCleanup(
      {
        objectKeyPrefix: prefix,
      },
      async () => {
        const now = nowDate();
        const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        const refreshAfter = new Date(now.getTime() - 60 * 1000);
        const inactiveRequestedAt = new Date(
          now.getTime() - 48 * 60 * 60 * 1000,
        );

        for (let index = 0; index < 2; index += 1) {
          const versionId = `a${index}`.repeat(32).slice(0, 64);
          await seedCacheRow({
            bucket: BUCKET,
            objectKey: `${prefix}/${versionId}/archive.tar.gz`,
            storageVersionId: versionId,
            presignedUrl: `https://r2.example.com/active-old-${index}`,
            expiresAt,
            refreshAfter: new Date(refreshAfter.getTime() + index),
            lastRequestedAt: now,
          });
        }

        const inactiveVersionId = "f".repeat(64);
        await seedCacheRow({
          bucket: BUCKET,
          objectKey: `${prefix}/${inactiveVersionId}/archive.tar.gz`,
          storageVersionId: inactiveVersionId,
          presignedUrl: "https://r2.example.com/inactive-old",
          expiresAt,
          refreshAfter,
          lastRequestedAt: inactiveRequestedAt,
        });

        const refreshed = await accept(
          cronClient().refresh({ headers: cronHeaders() }),
          [200],
        );
        expect(refreshed.body).toStrictEqual({
          success: true,
          due: 2,
          refreshed: 2,
          pruned: 0,
        });

        const rows = await readCacheRowsByObjectKeyPrefix(prefix);
        expect(
          rows.filter((row) => {
            return row.presigned_url.includes("?sig=");
          }),
        ).toHaveLength(2);
        expect(
          rows.find((row) => {
            return row.storage_version_id === inactiveVersionId;
          })?.presigned_url,
        ).toBe("https://r2.example.com/inactive-old");
      },
    );
  });

  it("prunes inactive expired cache rows from cron", async () => {
    const prefix = `${SYSTEM_ORG_ID}/volume/cache-prune-${randomUUID()}`;
    await withCacheCleanup(
      {
        objectKeyPrefix: prefix,
      },
      async () => {
        const now = nowDate();
        const expiredAt = new Date(now.getTime() - 60 * 60 * 1000);
        const futureExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        const refreshAfter = new Date(now.getTime() - 60 * 1000);
        const inactiveRequestedAt = new Date(
          now.getTime() - 48 * 60 * 60 * 1000,
        );

        for (let index = 0; index < 2; index += 1) {
          const versionId = `p${index}`.repeat(32).slice(0, 64);
          await seedCacheRow({
            bucket: BUCKET,
            objectKey: `${prefix}/${versionId}/archive.tar.gz`,
            storageVersionId: versionId,
            presignedUrl: `https://r2.example.com/expired-inactive-${index}`,
            expiresAt: expiredAt,
            refreshAfter,
            lastRequestedAt: inactiveRequestedAt,
          });
        }

        const inactiveFreshVersionId = "p9".repeat(32).slice(0, 64);
        await seedCacheRow({
          bucket: BUCKET,
          objectKey: `${prefix}/${inactiveFreshVersionId}/archive.tar.gz`,
          storageVersionId: inactiveFreshVersionId,
          presignedUrl: "https://r2.example.com/fresh-inactive",
          expiresAt: futureExpiresAt,
          refreshAfter,
          lastRequestedAt: inactiveRequestedAt,
        });

        const refreshed = await accept(
          cronClient().refresh({ headers: cronHeaders() }),
          [200],
        );
        expect(refreshed.body).toStrictEqual({
          success: true,
          due: 0,
          refreshed: 0,
          pruned: 2,
        });

        const rows = await readCacheRowsByObjectKeyPrefix(prefix);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.storage_version_id).toBe(inactiveFreshVersionId);
      },
    );
  });
});
