import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryPublicationProvenance } from "@okouai/db/schema/pi-memory-publication-provenance";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages, storageVersions } from "@okouai/db/schema/storage";

import { db } from "../../../lib/db";
import type { ApiDb } from "../../../lib/db-types";
import { env } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { commitPiMemoryStage1Candidate } from "../pi-memory-stage1-candidate.service";
import {
  claimPiMemoryPhase2Job,
  finalizePiMemoryPhase2Job,
  heartbeatPiMemoryPhase2Job,
  notifyPiMemoryPhase2ExternalHeadChange,
} from "../pi-memory-phase2-job.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
  insertPhase2StorageVersion,
  readPhase2Job,
  setPhase2StorageHead,
  type Phase2TestScope,
  type Phase2TestVersion,
} from "./pi-memory-phase2-job.test-fixture";

const NOW = Object.freeze(new Date("2026-09-03T04:00:00.000Z"));

interface DedicatedDatabase {
  readonly client: Client;
  readonly db: ApiDb;
  readonly pid: number;
}

async function openDedicatedDatabase(): Promise<DedicatedDatabase> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  await client.connect();
  const pidResult = await client.query<{ pid: number }>(
    `SELECT pg_backend_pid() AS "pid"`,
  );
  const pid = pidResult.rows[0]?.pid;
  if (!pid) {
    await client.end();
    throw new Error("Dedicated PostgreSQL connection has no backend PID");
  }
  return { client, db: drizzle(client), pid };
}

async function closeDedicatedDatabases(
  databases: readonly DedicatedDatabase[],
): Promise<void> {
  for (const database of databases) {
    await database.client.end();
  }
}

async function waitForPostgresBlock(
  observer: Client,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS "blocked"`,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) {
      return;
    }
    await observer.query(`SELECT pg_sleep(0.01)`);
  }
  throw new Error(
    `PostgreSQL backend ${blockedPid} did not block on ${blockerPid}`,
  );
}

async function lockPhase2Job(
  database: DedicatedDatabase,
  scope: Phase2TestScope,
): Promise<void> {
  await database.client.query("BEGIN");
  await database.client.query(
    `
      SELECT "memory_storage_id"
      FROM "pi_memory_phase2_jobs"
      WHERE "memory_storage_id" = $1
        AND "org_id" = $2
        AND "user_id" = $3
      FOR UPDATE
    `,
    [scope.memoryStorageId, scope.orgId, scope.userId],
  );
}

async function requireClaim(scope: Phase2TestScope, currentTime = NOW) {
  const claim = await claimPiMemoryPhase2Job(db(), { scope, currentTime });
  if (!claim) {
    throw new Error("Expected Pi memory Phase 2 claim");
  }
  return claim;
}

function claimFence(
  scope: Phase2TestScope,
  claim: Awaited<ReturnType<typeof requireClaim>>,
  currentTime = new Date(NOW.getTime() + 1),
) {
  return {
    memoryStorageId: scope.memoryStorageId,
    orgId: scope.orgId,
    userId: scope.userId,
    leaseToken: claim.leaseToken,
    claimedRevision: claim.claimedRevision,
    claimedBaseVersionId: claim.baseVersion.versionId,
    currentTime,
  };
}

async function publishExternalHead(
  scope: Phase2TestScope,
  version: Phase2TestVersion,
  changedAt: Date,
): Promise<boolean> {
  return await db().transaction(async (tx) => {
    await tx
      .update(storages)
      .set({
        headVersionId: version.versionId,
        size: version.size,
        fileCount: version.fileCount,
        updatedAt: changedAt,
      })
      .where(
        and(
          eq(storages.id, scope.memoryStorageId),
          eq(storages.orgId, scope.orgId),
          eq(storages.userId, scope.userId),
        ),
      );
    return await notifyPiMemoryPhase2ExternalHeadChange(tx, {
      memoryStorageId: scope.memoryStorageId,
      orgId: scope.orgId,
      userId: scope.userId,
      observedHeadVersionId: version.versionId,
      changedAt,
    });
  });
}

async function readStorage(scope: Phase2TestScope) {
  const [storage] = await db()
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.id, scope.memoryStorageId),
        eq(storages.orgId, scope.orgId),
        eq(storages.userId, scope.userId),
      ),
    );
  return storage;
}

async function readProvenance(scope: Phase2TestScope) {
  return await db()
    .select()
    .from(piMemoryPublicationProvenance)
    .where(
      and(
        eq(
          piMemoryPublicationProvenance.memoryStorageId,
          scope.memoryStorageId,
        ),
        eq(piMemoryPublicationProvenance.orgId, scope.orgId),
        eq(piMemoryPublicationProvenance.userId, scope.userId),
      ),
    );
}

async function readMarkers(scope: Phase2TestScope) {
  return await db()
    .select({
      piSessionId: piMemoryStage1Candidates.piSessionId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
      marker: piMemoryStage1Candidates.lastSelectedSourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
      ),
    );
}

describe("Pi memory Phase 2 publication", () => {
  it("claims the exact canonical memory HEAD and its immutable version metadata", async () => {
    const scope = await createPhase2TestScope("claim-base");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);

    const claim = await requireClaim(scope);

    expect(claim.baseVersion).toStrictEqual({
      storageId: scope.baseVersion.storageId,
      versionId: scope.baseVersion.versionId,
      s3Key: scope.baseVersion.s3Key,
      size: scope.baseVersion.size,
      archiveSize: scope.baseVersion.archiveSize,
      fileCount: scope.baseVersion.fileCount,
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      claimedBaseVersionId: scope.baseVersion.versionId,
      lastObservedHeadVersionId: scope.baseVersion.versionId,
    });
  });

  it("rejects null, wrong-storage, wrong-name, and org-owned memory HEADs", async () => {
    const nullHead = await createPhase2TestScope("claim-null-head");
    await insertPendingPhase2Job(nullHead);
    await db()
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.id, nullHead.memoryStorageId));

    const wrongStorage = await createPhase2TestScope("claim-wrong-storage");
    const foreignStorage = await createPhase2TestScope("claim-foreign-version");
    await insertPendingPhase2Job(wrongStorage);
    await db()
      .update(storages)
      .set({ headVersionId: foreignStorage.baseVersion.versionId })
      .where(eq(storages.id, wrongStorage.memoryStorageId));

    const wrongName = await createPhase2TestScope("claim-wrong-name");
    await insertPendingPhase2Job(wrongName);
    await db()
      .update(storages)
      .set({ name: `not-memory-${randomUUID()}` })
      .where(eq(storages.id, wrongName.memoryStorageId));

    const orgOwned = await createPhase2TestScope("claim-org-owned", {
      userId: VOLUME_ORG_USER_ID,
    });
    await insertPendingPhase2Job(orgOwned);

    await expect(
      claimPiMemoryPhase2Job(db(), { scope: nullHead, currentTime: NOW }),
    ).resolves.toBeNull();
    await expect(
      claimPiMemoryPhase2Job(db(), { scope: wrongStorage, currentTime: NOW }),
    ).resolves.toBeNull();
    await expect(
      claimPiMemoryPhase2Job(db(), { scope: wrongName, currentTime: NOW }),
    ).resolves.toBeNull();
    await expect(
      claimPiMemoryPhase2Job(db(), { scope: orgOwned, currentTime: NOW }),
    ).resolves.toBeNull();
  });

  it("preserves a live lease and requeues one reconciliation revision per external HEAD", async () => {
    const scope = await createPhase2TestScope("external-lease");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const external = await insertPhase2StorageVersion(scope, "external");
    const changedAt = new Date(NOW.getTime() + 1);

    await expect(
      publishExternalHead(scope, external, changedAt),
    ).resolves.toBeTruthy();
    await expect(
      db().transaction(async (tx) => {
        return await notifyPiMemoryPhase2ExternalHeadChange(tx, {
          memoryStorageId: scope.memoryStorageId,
          orgId: scope.orgId,
          userId: scope.userId,
          observedHeadVersionId: external.versionId,
          changedAt: new Date(changedAt.getTime() + 1),
        });
      }),
    ).resolves.toBeFalsy();

    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "leased",
      inputRevision: 2,
      reconciliationRevision: 2,
      claimedRevision: 1,
      claimedBaseVersionId: scope.baseVersion.versionId,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      lastObservedHeadVersionId: external.versionId,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
    });
  });

  it("requeues non-leased failures without carrying model retry or backoff state", async () => {
    const scope = await createPhase2TestScope("external-failure-reset");
    await insertPendingPhase2Job(scope, {
      status: "retryable_failure",
      retryCount: 2,
      retryAt: new Date(NOW.getTime() + 60_000),
      lastErrorClass: "model_failure",
      lastObservedHeadVersionId: scope.baseVersion.versionId,
    });
    const external = await insertPhase2StorageVersion(scope, "external");

    await expect(
      publishExternalHead(scope, external, NOW),
    ).resolves.toBeTruthy();
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      inputRevision: 2,
      completedRevision: 0,
      reconciliationRevision: 2,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      lastObservedHeadVersionId: external.versionId,
    });
  });

  it("publishes a prepared version with exact CAS, provenance, projection, and selection state", async () => {
    const scope = await createPhase2TestScope("prepared-success");
    const [selectedHash] = await insertPhase2Candidates(scope, [
      { piSessionId: "selected", rawMemory: "selected raw memory" },
    ]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared", {
      size: 404,
      archiveSize: 303,
      fileCount: 7,
    });
    const completedAt = new Date(NOW.getTime() + 1);
    const args = {
      ...claimFence(scope, claim, completedAt),
      selected: claim.selected,
      result: { kind: "prepared" as const, version: prepared },
    };

    await expect(finalizePiMemoryPhase2Job(db(), args)).resolves.toStrictEqual({
      outcome: "published",
      publishedVersionId: prepared.versionId,
    });

    await expect(readStorage(scope)).resolves.toMatchObject({
      headVersionId: prepared.versionId,
      size: prepared.size,
      fileCount: prepared.fileCount,
      updatedAt: completedAt,
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "idle",
      inputRevision: 1,
      completedRevision: 1,
      reconciliationRevision: 0,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      lastObservedHeadVersionId: prepared.versionId,
      lastPublishedVersionId: prepared.versionId,
      lastPublishedAt: completedAt,
      conflictCount: 0,
      retryCount: 0,
    });
    await expect(readMarkers(scope)).resolves.toStrictEqual([
      {
        piSessionId: "selected",
        sourceHistoryHash: selectedHash,
        marker: selectedHash,
      },
    ]);
    await expect(readProvenance(scope)).resolves.toStrictEqual([
      expect.objectContaining({
        memoryStorageId: scope.memoryStorageId,
        orgId: scope.orgId,
        userId: scope.userId,
        claimedRevision: 1,
        inputRevision: 1,
        reconciliationRevision: 0,
        baseVersionId: scope.baseVersion.versionId,
        preparedVersionId: prepared.versionId,
        observedHeadVersionId: prepared.versionId,
        writer: "pi",
        outcome: "published",
        size: prepared.size,
        archiveSize: prepared.archiveSize,
        fileCount: prepared.fileCount,
        createdAt: completedAt,
      }),
    ]);
    const [projection] = await db()
      .select()
      .from(memorySummaryProjections)
      .where(
        and(
          eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
          eq(memorySummaryProjections.storageVersionId, prepared.versionId),
        ),
      );
    expect(projection).toMatchObject({
      orgId: scope.orgId,
      userId: scope.userId,
      status: "pending",
    });

    await expect(finalizePiMemoryPhase2Job(db(), args)).resolves.toStrictEqual({
      outcome: "stale",
    });
    const replayedProvenance = await readProvenance(scope);
    expect(replayedProvenance).toHaveLength(1);
    expect(Object.keys(replayedProvenance[0] ?? {}).sort()).toStrictEqual(
      [
        "archiveSize",
        "baseVersionId",
        "claimedRevision",
        "createdAt",
        "fileCount",
        "id",
        "inputRevision",
        "memoryStorageId",
        "observedHeadVersionId",
        "orgId",
        "outcome",
        "preparedVersionId",
        "reconciliationRevision",
        "selectedCount",
        "selectedUtf8Bytes",
        "selectionDigest",
        "size",
        "userId",
        "writer",
      ].sort(),
    );
  });

  it("finalizes no-diff only against the claimed HEAD without publication side effects", async () => {
    const scope = await createPhase2TestScope("no-diff-success");
    const [selectedHash] = await insertPhase2Candidates(scope, [
      { piSessionId: "selected" },
    ]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const storageBefore = await readStorage(scope);
    const versionsBefore = await db()
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.storageId, scope.memoryStorageId));

    await expect(
      finalizePiMemoryPhase2Job(db(), {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 1)),
        selected: claim.selected,
        result: { kind: "no_diff" },
      }),
    ).resolves.toStrictEqual({
      outcome: "no_diff",
      headVersionId: scope.baseVersion.versionId,
    });

    await expect(readStorage(scope)).resolves.toStrictEqual(storageBefore);
    await expect(
      db()
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.storageId, scope.memoryStorageId)),
    ).resolves.toStrictEqual(versionsBefore);
    await expect(readProvenance(scope)).resolves.toStrictEqual([]);
    await expect(
      db()
        .select()
        .from(memorySummaryProjections)
        .where(
          eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
        ),
    ).resolves.toStrictEqual([]);
    await expect(readMarkers(scope)).resolves.toStrictEqual([
      {
        piSessionId: "selected",
        sourceHistoryHash: selectedHash,
        marker: selectedHash,
      },
    ]);
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "idle",
      inputRevision: 1,
      completedRevision: 1,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      lastObservedHeadVersionId: scope.baseVersion.versionId,
      lastPublishedVersionId: null,
      retryCount: 0,
    });
  });

  it("rejects mismatched prepared metadata with zero state mutation", async () => {
    const scope = await createPhase2TestScope("prepared-mismatch");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared");
    const storageBefore = await readStorage(scope);
    const jobBefore = await readPhase2Job(scope);
    const markersBefore = await readMarkers(scope);

    await expect(
      finalizePiMemoryPhase2Job(db(), {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 1)),
        selected: claim.selected,
        result: {
          kind: "prepared",
          version: { ...prepared, archiveSize: prepared.archiveSize + 1 },
        },
      }),
    ).resolves.toStrictEqual({ outcome: "stale" });

    await expect(readStorage(scope)).resolves.toStrictEqual(storageBefore);
    await expect(readPhase2Job(scope)).resolves.toStrictEqual(jobBefore);
    await expect(readMarkers(scope)).resolves.toStrictEqual(markersBefore);
    await expect(readProvenance(scope)).resolves.toStrictEqual([]);
    await expect(
      db()
        .select()
        .from(memorySummaryProjections)
        .where(
          eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
        ),
    ).resolves.toStrictEqual([]);
  });

  it("keeps a detached prepared version and immediately reconciles an expected CAS miss", async () => {
    const scope = await createPhase2TestScope("prepared-conflict");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope, { retryCount: 0 });
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "detached", {
      s3Key: `secret-prepared-key-${randomUUID()}`,
    });
    const external = await insertPhase2StorageVersion(scope, "external");
    const conflictAt = new Date(NOW.getTime() + 2);
    await publishExternalHead(scope, external, new Date(NOW.getTime() + 1));

    await expect(
      finalizePiMemoryPhase2Job(db(), {
        ...claimFence(scope, claim, conflictAt),
        selected: claim.selected,
        result: { kind: "prepared", version: prepared },
      }),
    ).resolves.toStrictEqual({
      outcome: "conflicted",
      currentHeadVersionId: external.versionId,
    });

    await expect(readStorage(scope)).resolves.toMatchObject({
      headVersionId: external.versionId,
      size: external.size,
      fileCount: external.fileCount,
    });
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      inputRevision: 2,
      completedRevision: 0,
      reconciliationRevision: 2,
      claimedRevision: null,
      claimedBaseVersionId: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      lastObservedHeadVersionId: external.versionId,
      conflictCount: 1,
      lastConflictAt: conflictAt,
      lastConflictingHeadVersionId: external.versionId,
    });
    expect(
      (await readMarkers(scope)).every((row) => {
        return row.marker === null;
      }),
    ).toBeTruthy();
    const provenance = await readProvenance(scope);
    expect(provenance).toStrictEqual([
      expect.objectContaining({
        baseVersionId: scope.baseVersion.versionId,
        preparedVersionId: prepared.versionId,
        observedHeadVersionId: external.versionId,
        writer: "pi",
        outcome: "conflicted",
        createdAt: conflictAt,
      }),
    ]);
    expect(JSON.stringify(provenance)).not.toContain(prepared.s3Key);
    await expect(
      db()
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(eq(storageVersions.id, prepared.versionId)),
    ).resolves.toStrictEqual([{ id: prepared.versionId }]);

    const reconciliationClaim = await requireClaim(
      scope,
      new Date(conflictAt.getTime() + 1),
    );
    expect(reconciliationClaim).toMatchObject({
      claimedRevision: 2,
      baseVersion: {
        storageId: external.storageId,
        versionId: external.versionId,
        s3Key: external.s3Key,
        size: external.size,
        archiveSize: external.archiveSize,
        fileCount: external.fileCount,
      },
    });
    const descendant = await insertPhase2StorageVersion(scope, "descendant");
    await expect(
      finalizePiMemoryPhase2Job(db(), {
        ...claimFence(
          scope,
          reconciliationClaim,
          new Date(conflictAt.getTime() + 2),
        ),
        selected: reconciliationClaim.selected,
        result: { kind: "prepared", version: descendant },
      }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect((await readProvenance(scope))[1]).toMatchObject({
      baseVersionId: external.versionId,
      preparedVersionId: descendant.versionId,
      writer: "reconciler",
      outcome: "published",
    });
  });

  it("treats no-diff HEAD movement as conflict and stale base fences as zero mutation", async () => {
    const scope = await createPhase2TestScope("no-diff-movement");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const external = await insertPhase2StorageVersion(scope, "external");
    await setPhase2StorageHead(scope, external, new Date(NOW.getTime() + 1));
    const beforeStale = await readPhase2Job(scope);

    await expect(
      heartbeatPiMemoryPhase2Job(db(), {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 2)),
        claimedBaseVersionId: external.versionId,
      }),
    ).resolves.toBeFalsy();
    await expect(readPhase2Job(scope)).resolves.toStrictEqual(beforeStale);

    await expect(
      finalizePiMemoryPhase2Job(db(), {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 3)),
        selected: claim.selected,
        result: { kind: "no_diff" },
      }),
    ).resolves.toStrictEqual({
      outcome: "conflicted",
      currentHeadVersionId: external.versionId,
    });
    await expect(readProvenance(scope)).resolves.toStrictEqual([]);
    expect(
      (await readMarkers(scope)).every((row) => {
        return row.marker === null;
      }),
    ).toBeTruthy();
    await expect(readPhase2Job(scope)).resolves.toMatchObject({
      status: "pending",
      retryCount: 0,
      conflictCount: 1,
      lastConflictingHeadVersionId: external.versionId,
    });
  });

  it("does not create a job when an external memory HEAD changes outside Phase 2", async () => {
    const scope = await createPhase2TestScope("external-no-job");
    const external = await insertPhase2StorageVersion(scope, "external");

    await expect(
      publishExternalHead(scope, external, NOW),
    ).resolves.toBeFalsy();
    await expect(readPhase2Job(scope)).resolves.toBeUndefined();
    await expect(
      db()
        .select({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId })
        .from(piMemoryPhase2Jobs)
        .where(eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId)),
    ).resolves.toStrictEqual([]);
  });

  it("cascades publication provenance with its owning memory Storage", async () => {
    const scope = await createPhase2TestScope("provenance-cascade");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared");
    await finalizePiMemoryPhase2Job(db(), {
      ...claimFence(scope, claim, new Date(NOW.getTime() + 1)),
      selected: claim.selected,
      result: { kind: "prepared", version: prepared },
    });
    await expect(readProvenance(scope)).resolves.toHaveLength(1);

    await db()
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.id, scope.memoryStorageId));
    await db().delete(storages).where(eq(storages.id, scope.memoryStorageId));

    await expect(readProvenance(scope)).resolves.toStrictEqual([]);
  });

  it("deterministically preserves an external winner before Pi CAS", async () => {
    const scope = await createPhase2TestScope("race-external-first");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared");
    const external = await insertPhase2StorageVersion(scope, "external");
    const externalDatabase = await openDedicatedDatabase();
    const finalizerDatabase = await openDedicatedDatabase();
    const observer = await openDedicatedDatabase();
    const owner = new AbortController();
    const storageLocked = createDeferredPromise<void>(owner.signal);
    const releaseExternal = createDeferredPromise<void>(owner.signal);
    let externalTransaction: Promise<boolean> | undefined;
    let finalization: ReturnType<typeof finalizePiMemoryPhase2Job> | undefined;
    try {
      externalTransaction = externalDatabase.db.transaction(async (tx) => {
        await tx
          .update(storages)
          .set({
            headVersionId: external.versionId,
            size: external.size,
            fileCount: external.fileCount,
            updatedAt: new Date(NOW.getTime() + 1),
          })
          .where(eq(storages.id, scope.memoryStorageId));
        const notified = await notifyPiMemoryPhase2ExternalHeadChange(tx, {
          memoryStorageId: scope.memoryStorageId,
          orgId: scope.orgId,
          userId: scope.userId,
          observedHeadVersionId: external.versionId,
          changedAt: new Date(NOW.getTime() + 1),
        });
        storageLocked.resolve();
        await releaseExternal.promise;
        return notified;
      });
      await storageLocked.promise;

      finalization = finalizePiMemoryPhase2Job(finalizerDatabase.db, {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 2)),
        selected: claim.selected,
        result: { kind: "prepared", version: prepared },
      });
      await waitForPostgresBlock(
        observer.client,
        finalizerDatabase.pid,
        externalDatabase.pid,
      );
      releaseExternal.resolve();

      await expect(externalTransaction).resolves.toBeTruthy();
      await expect(finalization).resolves.toStrictEqual({
        outcome: "conflicted",
        currentHeadVersionId: external.versionId,
      });
      await expect(readStorage(scope)).resolves.toMatchObject({
        headVersionId: external.versionId,
      });
      await expect(readPhase2Job(scope)).resolves.toMatchObject({
        status: "pending",
        reconciliationRevision: 2,
        retryCount: 0,
      });
    } finally {
      if (!releaseExternal.settled()) {
        releaseExternal.resolve();
      }
      await Promise.allSettled([externalTransaction, finalization]);
      owner.abort();
      await closeDedicatedDatabases([
        externalDatabase,
        finalizerDatabase,
        observer,
      ]);
    }
  });

  it("deterministically lets Pi CAS commit before an external overwrite and requeue", async () => {
    const scope = await createPhase2TestScope("race-pi-first");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared");
    const external = await insertPhase2StorageVersion(scope, "external");
    const jobBlocker = await openDedicatedDatabase();
    const finalizerDatabase = await openDedicatedDatabase();
    const externalDatabase = await openDedicatedDatabase();
    const observer = await openDedicatedDatabase();
    let finalization: ReturnType<typeof finalizePiMemoryPhase2Job> | undefined;
    let externalTransaction: Promise<boolean> | undefined;
    let blockerOpen = false;
    try {
      await lockPhase2Job(jobBlocker, scope);
      blockerOpen = true;
      finalization = finalizePiMemoryPhase2Job(finalizerDatabase.db, {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 1)),
        selected: claim.selected,
        result: { kind: "prepared", version: prepared },
      });
      await waitForPostgresBlock(
        observer.client,
        finalizerDatabase.pid,
        jobBlocker.pid,
      );

      externalTransaction = externalDatabase.db.transaction(async (tx) => {
        await tx
          .update(storages)
          .set({
            headVersionId: external.versionId,
            size: external.size,
            fileCount: external.fileCount,
            updatedAt: new Date(NOW.getTime() + 2),
          })
          .where(eq(storages.id, scope.memoryStorageId));
        return await notifyPiMemoryPhase2ExternalHeadChange(tx, {
          memoryStorageId: scope.memoryStorageId,
          orgId: scope.orgId,
          userId: scope.userId,
          observedHeadVersionId: external.versionId,
          changedAt: new Date(NOW.getTime() + 2),
        });
      });
      await waitForPostgresBlock(
        observer.client,
        externalDatabase.pid,
        finalizerDatabase.pid,
      );

      await jobBlocker.client.query("COMMIT");
      blockerOpen = false;
      await expect(finalization).resolves.toMatchObject({
        outcome: "published",
      });
      await expect(externalTransaction).resolves.toBeTruthy();
      await expect(readStorage(scope)).resolves.toMatchObject({
        headVersionId: external.versionId,
      });
      await expect(readPhase2Job(scope)).resolves.toMatchObject({
        status: "pending",
        inputRevision: 2,
        completedRevision: 1,
        reconciliationRevision: 2,
        lastObservedHeadVersionId: external.versionId,
        lastPublishedVersionId: prepared.versionId,
        retryCount: 0,
      });
    } finally {
      if (blockerOpen) {
        await jobBlocker.client.query("ROLLBACK");
      }
      await Promise.allSettled([finalization, externalTransaction]);
      await closeDedicatedDatabases([
        jobBlocker,
        finalizerDatabase,
        externalDatabase,
        observer,
      ]);
    }
  });

  it("serializes concurrent Stage 1 enqueue without a lock-order deadlock", async () => {
    const scope = await createPhase2TestScope("race-stage1");
    await insertPhase2Candidates(scope, [{ piSessionId: "selected" }]);
    const stage1LeaseToken = randomUUID();
    const [stage1Hash] = await insertPhase2Candidates(scope, [
      {
        piSessionId: "new-stage1",
        status: "leased",
        leaseToken: stage1LeaseToken,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      },
    ]);
    await insertPendingPhase2Job(scope);
    const claim = await requireClaim(scope);
    const prepared = await insertPhase2StorageVersion(scope, "prepared");
    const jobBlocker = await openDedicatedDatabase();
    const stage1Database = await openDedicatedDatabase();
    const finalizerDatabase = await openDedicatedDatabase();
    const observer = await openDedicatedDatabase();
    let stage1Commit: Promise<boolean> | undefined;
    let finalization: ReturnType<typeof finalizePiMemoryPhase2Job> | undefined;
    let blockerOpen = false;
    try {
      await lockPhase2Job(jobBlocker, scope);
      blockerOpen = true;
      stage1Commit = stage1Database.db.transaction(async (tx) => {
        return await commitPiMemoryStage1Candidate(tx, {
          memoryStorageId: scope.memoryStorageId,
          orgId: scope.orgId,
          userId: scope.userId,
          piSessionId: "new-stage1",
          sourceHistoryHash: stage1Hash as string,
          leaseToken: stage1LeaseToken,
          committedAt: new Date(NOW.getTime() + 1),
          result: {
            kind: "succeeded",
            rawMemory: "new raw memory",
            rolloutSummary: "new rollout summary",
          },
        });
      });
      await waitForPostgresBlock(
        observer.client,
        stage1Database.pid,
        jobBlocker.pid,
      );

      finalization = finalizePiMemoryPhase2Job(finalizerDatabase.db, {
        ...claimFence(scope, claim, new Date(NOW.getTime() + 2)),
        selected: claim.selected,
        result: { kind: "prepared", version: prepared },
      });
      await waitForPostgresBlock(
        observer.client,
        finalizerDatabase.pid,
        stage1Database.pid,
      );

      await jobBlocker.client.query("COMMIT");
      blockerOpen = false;
      await expect(stage1Commit).resolves.toBeTruthy();
      await expect(finalization).resolves.toMatchObject({
        outcome: "published",
      });
      await expect(readPhase2Job(scope)).resolves.toMatchObject({
        status: "pending",
        inputRevision: 2,
        completedRevision: 1,
      });
      const markers = await readMarkers(scope);
      expect(
        markers.find((candidate) => {
          return candidate.piSessionId === "new-stage1";
        })?.marker,
      ).toBeNull();
    } finally {
      if (blockerOpen) {
        await jobBlocker.client.query("ROLLBACK");
      }
      await Promise.allSettled([stage1Commit, finalization]);
      await closeDedicatedDatabases([
        jobBlocker,
        stage1Database,
        finalizerDatabase,
        observer,
      ]);
    }
  });
});
