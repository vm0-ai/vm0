import { createHash, randomUUID } from "node:crypto";

import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
import {
  piMemoryPublicationProvenance,
  type PiMemoryPublicationWriter,
} from "@okouai/db/schema/pi-memory-publication-provenance";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";
import { enqueueMemorySummaryProjection } from "./memory-summary-projection.service";
import {
  storageVersionMatches,
  type PreparedStorageVersion,
} from "./storage-version-registration.service";

export const PI_MEMORY_PHASE2_LEASE_DURATION_MS = 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS = 90 * 1000;
export const PI_MEMORY_PHASE2_RETRY_DELAY_MS = 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const PI_MEMORY_PHASE2_SELECTION_ENCODING = "vm0.pi-memory.phase2.selection.v1";

interface PiMemoryPhase2OwnerScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface PiMemoryPhase2SelectedCandidate {
  readonly piSessionId: string;
  readonly sourceRunId: string;
  readonly sourceHistoryHash: string;
  readonly sourceCompletedAt: Date;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug: string | null;
}

interface ClaimedPiMemoryPhase2BaseVersion {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}

interface ClaimedPiMemoryPhase2Job extends PiMemoryPhase2OwnerScope {
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly claimedRevision: number;
  readonly baseVersion: ClaimedPiMemoryPhase2BaseVersion;
  readonly selected: readonly PiMemoryPhase2SelectedCandidate[];
}

interface ClaimPiMemoryPhase2JobArgs {
  readonly currentTime: Date;
  readonly scope?: PiMemoryPhase2OwnerScope;
}

interface PiMemoryPhase2LeaseFence extends PiMemoryPhase2OwnerScope {
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly currentTime: Date;
}

type FinalizePiMemoryPhase2JobResult =
  | { readonly outcome: "stale" }
  | {
      readonly outcome: "conflicted";
      readonly currentHeadVersionId: string;
    }
  | { readonly outcome: "no_diff"; readonly headVersionId: string }
  | {
      readonly outcome: "published";
      readonly publishedVersionId: string;
    };

interface PiMemoryPhase2SelectionMetadata {
  readonly digest: string;
  readonly count: number;
  readonly utf8Bytes: number;
}

function uint32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function piMemoryPhase2SelectionDigest(
  selected: readonly Pick<
    PiMemoryPhase2SelectedCandidate,
    "piSessionId" | "sourceHistoryHash"
  >[],
): string {
  const version = Buffer.from(PI_MEMORY_PHASE2_SELECTION_ENCODING, "utf8");
  const parts: Buffer[] = [
    uint32Buffer(version.length),
    version,
    uint32Buffer(selected.length),
  ];
  for (const candidate of selected) {
    const piSessionId = Buffer.from(candidate.piSessionId, "utf8");
    const sourceHistoryHash = Buffer.from(candidate.sourceHistoryHash, "utf8");
    parts.push(
      uint32Buffer(piSessionId.length),
      piSessionId,
      uint32Buffer(sourceHistoryHash.length),
      sourceHistoryHash,
    );
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

function candidateUtf8Bytes(
  candidate: PiMemoryPhase2SelectedCandidate,
): number {
  return (
    Buffer.byteLength(candidate.rawMemory, "utf8") +
    Buffer.byteLength(candidate.rolloutSummary, "utf8") +
    Buffer.byteLength(candidate.rolloutSlug ?? "", "utf8")
  );
}

function selectionMetadata(
  selected: readonly PiMemoryPhase2SelectedCandidate[],
): PiMemoryPhase2SelectionMetadata | null {
  if (selected.length > PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES) {
    return null;
  }
  const piSessionIds = new Set<string>();
  let utf8Bytes = 0;
  for (const candidate of selected) {
    if (piSessionIds.has(candidate.piSessionId)) {
      return null;
    }
    piSessionIds.add(candidate.piSessionId);
    utf8Bytes += candidateUtf8Bytes(candidate);
    if (utf8Bytes > PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES) {
      return null;
    }
  }
  return {
    digest: piMemoryPhase2SelectionDigest(selected),
    count: selected.length,
    utf8Bytes,
  };
}

export async function advancePiMemoryPhase2InputRevision(
  tx: Tx,
  args: PiMemoryPhase2OwnerScope & { readonly enqueuedAt: Date },
): Promise<void> {
  const [advanced] = await tx
    .insert(piMemoryPhase2Jobs)
    .values({
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      updatedAt: args.enqueuedAt,
    })
    .onConflictDoUpdate({
      target: piMemoryPhase2Jobs.memoryStorageId,
      set: {
        orgId: args.orgId,
        userId: args.userId,
        status: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
          ELSE 'pending'
        END`,
        inputRevision: sql`${piMemoryPhase2Jobs.inputRevision} + 1`,
        claimedRevision: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedRevision}
          ELSE NULL
        END`,
        claimedBaseVersionId: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
          ELSE NULL
        END`,
        leaseToken: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseToken}
          ELSE NULL
        END`,
        leaseExpiresAt: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
          ELSE NULL
        END`,
        retryCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.retryCount}
          ELSE 0
        END`,
        retryAt: null,
        lastErrorClass: null,
        claimedSelectionDigest: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
          ELSE NULL
        END`,
        claimedSelectedCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
          ELSE NULL
        END`,
        claimedSelectedUtf8Bytes: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
          ELSE NULL
        END`,
        updatedAt: args.enqueuedAt,
      },
    })
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!advanced) {
    throw new Error("Pi memory Phase 2 input revision did not advance");
  }
}

export async function notifyPiMemoryPhase2ExternalHeadChange(
  tx: Tx,
  args: PiMemoryPhase2OwnerScope & {
    readonly observedHeadVersionId: string;
    readonly changedAt: Date;
  },
): Promise<boolean> {
  const [memory] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.id, args.memoryStorageId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        ne(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        eq(storages.headVersionId, args.observedHeadVersionId),
      ),
    )
    .limit(1)
    .for("update", { of: storages });
  if (!memory) {
    return false;
  }

  const [updated] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
        ELSE 'pending'
      END`,
      inputRevision: sql`${piMemoryPhase2Jobs.inputRevision} + 1`,
      reconciliationRevision: sql`${piMemoryPhase2Jobs.inputRevision} + 1`,
      claimedRevision: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedRevision}
        ELSE NULL
      END`,
      claimedBaseVersionId: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
        ELSE NULL
      END`,
      leaseToken: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseToken}
        ELSE NULL
      END`,
      leaseExpiresAt: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
        ELSE NULL
      END`,
      retryCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.retryCount}
        ELSE 0
      END`,
      retryAt: null,
      lastErrorClass: null,
      claimedSelectionDigest: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
        ELSE NULL
      END`,
      claimedSelectedCount: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
        ELSE NULL
      END`,
      claimedSelectedUtf8Bytes: sql`CASE
        WHEN ${piMemoryPhase2Jobs.status} = 'leased'
        THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
        ELSE NULL
      END`,
      lastObservedHeadVersionId: args.observedHeadVersionId,
      updatedAt: args.changedAt,
    })
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, args.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, args.orgId),
        eq(piMemoryPhase2Jobs.userId, args.userId),
        or(
          isNull(piMemoryPhase2Jobs.lastObservedHeadVersionId),
          ne(
            piMemoryPhase2Jobs.lastObservedHeadVersionId,
            args.observedHeadVersionId,
          ),
        ),
      ),
    )
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  return updated !== undefined;
}

function claimScopeCondition(scope: PiMemoryPhase2OwnerScope | undefined) {
  return scope
    ? and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
      )
    : undefined;
}

async function selectClaimCandidates(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
  currentTime: Date,
): Promise<readonly PiMemoryPhase2SelectedCandidate[]> {
  const oldestAllowed = new Date(
    currentTime.getTime() - PI_MEMORY_PHASE2_MAX_UNUSED_AGE_MS,
  );
  const ranked = await tx
    .select({
      piSessionId: piMemoryStage1Candidates.piSessionId,
      sourceRunId: piMemoryStage1Candidates.sourceRunId,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      rawMemory: piMemoryStage1Candidates.rawMemory,
      rolloutSummary: piMemoryStage1Candidates.rolloutSummary,
      rolloutSlug: piMemoryStage1Candidates.rolloutSlug,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
        eq(piMemoryStage1Candidates.status, "succeeded"),
        sql`(
          btrim(${piMemoryStage1Candidates.rawMemory}, E' \t\n\r\f\v') <> '' OR
          btrim(${piMemoryStage1Candidates.rolloutSummary}, E' \t\n\r\f\v') <> ''
        )`,
        or(
          and(
            isNotNull(piMemoryStage1Candidates.lastUsedAt),
            gte(piMemoryStage1Candidates.lastUsedAt, oldestAllowed),
            lte(piMemoryStage1Candidates.lastUsedAt, currentTime),
          ),
          and(
            isNull(piMemoryStage1Candidates.lastUsedAt),
            gte(piMemoryStage1Candidates.sourceCompletedAt, oldestAllowed),
            lte(piMemoryStage1Candidates.sourceCompletedAt, currentTime),
          ),
        ),
      ),
    )
    .orderBy(
      desc(piMemoryStage1Candidates.usageCount),
      desc(
        sql`COALESCE(
          ${piMemoryStage1Candidates.lastUsedAt},
          ${piMemoryStage1Candidates.sourceCompletedAt}
        )`,
      ),
      desc(piMemoryStage1Candidates.sourceCompletedAt),
      desc(piMemoryStage1Candidates.piSessionId),
    )
    .limit(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES);

  const selected: PiMemoryPhase2SelectedCandidate[] = [];
  let selectedUtf8Bytes = 0;
  for (const candidate of ranked) {
    if (candidate.rawMemory === null || candidate.rolloutSummary === null) {
      throw new Error("Succeeded Pi memory Stage 1 candidate has no output");
    }
    const snapshot = {
      piSessionId: candidate.piSessionId,
      sourceRunId: candidate.sourceRunId,
      sourceHistoryHash: candidate.sourceHistoryHash,
      sourceCompletedAt: candidate.sourceCompletedAt,
      rawMemory: candidate.rawMemory,
      rolloutSummary: candidate.rolloutSummary,
      rolloutSlug: candidate.rolloutSlug,
    };
    const nextUtf8Bytes = selectedUtf8Bytes + candidateUtf8Bytes(snapshot);
    if (nextUtf8Bytes > PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES) {
      break;
    }
    selected.push(snapshot);
    selectedUtf8Bytes = nextUtf8Bytes;
  }
  return selected.sort((left, right) => {
    if (left.piSessionId < right.piSessionId) {
      return -1;
    }
    if (left.piSessionId > right.piSessionId) {
      return 1;
    }
    return 0;
  });
}

async function lockPhase2CandidateSet(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
): Promise<void> {
  await tx
    .select({ piSessionId: piMemoryStage1Candidates.piSessionId })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
      ),
    )
    .orderBy(asc(piMemoryStage1Candidates.piSessionId))
    .for("update", { of: piMemoryStage1Candidates });
}

export async function claimPiMemoryPhase2Job(
  db: ApiDb,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<ClaimedPiMemoryPhase2Job | null> {
  return await db.transaction(async (tx) => {
    const claimableStorage = await lockNextClaimableStorage(tx, args);
    if (!claimableStorage) {
      return null;
    }

    const [baseVersion] = await tx
      .select({
        storageId: storageVersions.storageId,
        versionId: storageVersions.id,
        s3Key: storageVersions.s3Key,
        size: storageVersions.size,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
      })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, claimableStorage.memoryStorageId),
          eq(storageVersions.id, claimableStorage.baseVersionId),
        ),
      )
      .limit(1);
    if (!baseVersion) {
      return null;
    }

    const scope = {
      memoryStorageId: claimableStorage.memoryStorageId,
      orgId: claimableStorage.orgId,
      userId: claimableStorage.userId,
    };
    await lockPhase2CandidateSet(tx, scope);
    const selected = await selectClaimCandidates(tx, scope, args.currentTime);
    const job = await lockClaimableJob(tx, args, scope);
    if (!job) {
      return null;
    }

    const retryCount =
      job.status === "leased"
        ? job.claimedRevision === job.inputRevision
          ? job.retryCount + 1
          : 0
        : job.retryCount;
    if (retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS) {
      await tx
        .update(piMemoryPhase2Jobs)
        .set({
          status: "terminal_failure",
          claimedRevision: null,
          claimedBaseVersionId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          retryCount: PI_MEMORY_PHASE2_MAX_ATTEMPTS,
          retryAt: null,
          lastErrorClass: "lease_expired",
          claimedSelectionDigest: null,
          claimedSelectedCount: null,
          claimedSelectedUtf8Bytes: null,
          updatedAt: args.currentTime,
        })
        .where(
          and(
            eq(piMemoryPhase2Jobs.memoryStorageId, job.memoryStorageId),
            eq(piMemoryPhase2Jobs.orgId, job.orgId),
            eq(piMemoryPhase2Jobs.userId, job.userId),
          ),
        );
      return null;
    }

    const metadata = selectionMetadata(selected);
    if (metadata === null) {
      throw new Error("Claimed Pi memory Phase 2 selection is out of bounds");
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      args.currentTime.getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
    );
    const [leased] = await tx
      .update(piMemoryPhase2Jobs)
      .set({
        status: "leased",
        claimedRevision: job.inputRevision,
        claimedBaseVersionId: baseVersion.versionId,
        leaseToken,
        leaseExpiresAt,
        retryCount,
        retryAt: null,
        lastErrorClass: null,
        claimedSelectionDigest: metadata.digest,
        claimedSelectedCount: metadata.count,
        claimedSelectedUtf8Bytes: metadata.utf8Bytes,
        lastObservedHeadVersionId: baseVersion.versionId,
        updatedAt: args.currentTime,
      })
      .where(
        and(
          eq(piMemoryPhase2Jobs.memoryStorageId, job.memoryStorageId),
          eq(piMemoryPhase2Jobs.orgId, job.orgId),
          eq(piMemoryPhase2Jobs.userId, job.userId),
        ),
      )
      .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
    if (!leased) {
      throw new Error("Locked Pi memory Phase 2 job could not be leased");
    }
    return {
      ...scope,
      leaseToken,
      leaseExpiresAt,
      claimedRevision: job.inputRevision,
      baseVersion,
      selected,
    };
  });
}

interface LockedClaimableJob extends PiMemoryPhase2OwnerScope {
  readonly status:
    | "pending"
    | "leased"
    | "retryable_failure"
    | "idle"
    | "terminal_failure";
  readonly inputRevision: number;
  readonly completedRevision: number;
  readonly claimedRevision: number | null;
  readonly retryCount: number;
}

interface LockedClaimableStorage extends PiMemoryPhase2OwnerScope {
  readonly baseVersionId: string;
}

function claimableJobCondition(args: ClaimPiMemoryPhase2JobArgs) {
  const cooldownBoundary = new Date(
    args.currentTime.getTime() - PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
  );
  return and(
    gt(piMemoryPhase2Jobs.inputRevision, piMemoryPhase2Jobs.completedRevision),
    or(
      eq(piMemoryPhase2Jobs.status, "pending"),
      and(
        eq(piMemoryPhase2Jobs.status, "retryable_failure"),
        lte(piMemoryPhase2Jobs.retryAt, args.currentTime),
      ),
      and(
        eq(piMemoryPhase2Jobs.status, "leased"),
        lte(piMemoryPhase2Jobs.leaseExpiresAt, args.currentTime),
      ),
    ),
    or(
      gt(
        piMemoryPhase2Jobs.reconciliationRevision,
        piMemoryPhase2Jobs.completedRevision,
      ),
      isNull(piMemoryPhase2Jobs.lastSucceededAt),
      lte(piMemoryPhase2Jobs.lastSucceededAt, cooldownBoundary),
    ),
    claimScopeCondition(args.scope),
  );
}

async function lockNextClaimableStorage(
  tx: Tx,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<LockedClaimableStorage | null> {
  const [storage] = await tx
    .select({
      memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
      orgId: piMemoryPhase2Jobs.orgId,
      userId: piMemoryPhase2Jobs.userId,
      baseVersionId: storages.headVersionId,
    })
    .from(piMemoryPhase2Jobs)
    .innerJoin(
      storages,
      and(
        eq(storages.id, piMemoryPhase2Jobs.memoryStorageId),
        eq(storages.orgId, piMemoryPhase2Jobs.orgId),
        eq(storages.userId, piMemoryPhase2Jobs.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        ne(storages.userId, VOLUME_ORG_USER_ID),
      ),
    )
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, storages.headVersionId),
      ),
    )
    .where(and(claimableJobCondition(args), isNotNull(storages.headVersionId)))
    .orderBy(
      asc(piMemoryPhase2Jobs.updatedAt),
      asc(piMemoryPhase2Jobs.memoryStorageId),
    )
    .limit(1)
    .for("update", { of: storages, skipLocked: true });
  if (!storage?.baseVersionId) {
    return null;
  }
  return {
    memoryStorageId: storage.memoryStorageId,
    orgId: storage.orgId,
    userId: storage.userId,
    baseVersionId: storage.baseVersionId,
  };
}

async function lockClaimableJob(
  tx: Tx,
  args: ClaimPiMemoryPhase2JobArgs,
  scope: PiMemoryPhase2OwnerScope,
): Promise<LockedClaimableJob | null> {
  const [job] = await tx
    .select({
      memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
      orgId: piMemoryPhase2Jobs.orgId,
      userId: piMemoryPhase2Jobs.userId,
      status: piMemoryPhase2Jobs.status,
      inputRevision: piMemoryPhase2Jobs.inputRevision,
      completedRevision: piMemoryPhase2Jobs.completedRevision,
      claimedRevision: piMemoryPhase2Jobs.claimedRevision,
      retryCount: piMemoryPhase2Jobs.retryCount,
    })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
        claimableJobCondition(args),
      ),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  return job ?? null;
}

function exactLeaseCondition(args: PiMemoryPhase2LeaseFence) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.orgId),
    eq(piMemoryPhase2Jobs.userId, args.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, args.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, args.claimedRevision),
    eq(piMemoryPhase2Jobs.claimedBaseVersionId, args.claimedBaseVersionId),
    gt(piMemoryPhase2Jobs.leaseExpiresAt, args.currentTime),
  );
}

export async function heartbeatPiMemoryPhase2Job(
  db: ApiDb,
  args: PiMemoryPhase2LeaseFence,
): Promise<boolean> {
  const [heartbeat] = await db
    .update(piMemoryPhase2Jobs)
    .set({
      leaseExpiresAt: new Date(
        args.currentTime.getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
      ),
      updatedAt: args.currentTime,
    })
    .where(exactLeaseCondition(args))
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  return heartbeat !== undefined;
}

export async function failPiMemoryPhase2Job(
  db: ApiDb,
  args: PiMemoryPhase2LeaseFence & { readonly errorClass: string },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [job] = await tx
      .select({
        inputRevision: piMemoryPhase2Jobs.inputRevision,
        retryCount: piMemoryPhase2Jobs.retryCount,
      })
      .from(piMemoryPhase2Jobs)
      .where(exactLeaseCondition(args))
      .limit(1)
      .for("update", { of: piMemoryPhase2Jobs });
    if (!job) {
      return false;
    }

    const hasNewerInput = job.inputRevision > args.claimedRevision;
    const retryCount = hasNewerInput ? 0 : job.retryCount + 1;
    const terminal = retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS;
    const [failed] = await tx
      .update(piMemoryPhase2Jobs)
      .set({
        status: hasNewerInput
          ? "pending"
          : terminal
            ? "terminal_failure"
            : "retryable_failure",
        claimedRevision: null,
        claimedBaseVersionId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        retryCount,
        retryAt:
          hasNewerInput || terminal
            ? null
            : new Date(
                args.currentTime.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
              ),
        lastErrorClass: hasNewerInput ? null : args.errorClass,
        claimedSelectionDigest: null,
        claimedSelectedCount: null,
        claimedSelectedUtf8Bytes: null,
        updatedAt: args.currentTime,
      })
      .where(exactLeaseCondition(args))
      .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
    return failed !== undefined;
  });
}

function selectionMatchesJob(
  job: {
    readonly claimedSelectionDigest: string | null;
    readonly claimedSelectedCount: number | null;
    readonly claimedSelectedUtf8Bytes: number | null;
  },
  metadata: PiMemoryPhase2SelectionMetadata,
): boolean {
  return (
    job.claimedSelectionDigest === metadata.digest &&
    job.claimedSelectedCount === metadata.count &&
    job.claimedSelectedUtf8Bytes === metadata.utf8Bytes
  );
}

interface LockedPiMemoryPhase2PublicationJob {
  readonly inputRevision: number;
  readonly completedRevision: number;
  readonly reconciliationRevision: number;
  readonly claimedSelectionDigest: string | null;
  readonly claimedSelectedCount: number | null;
  readonly claimedSelectedUtf8Bytes: number | null;
  readonly lastObservedHeadVersionId: string | null;
}

async function lockCanonicalMemoryStorage(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
) {
  const [storage] = await tx
    .select({
      id: storages.id,
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.id, scope.memoryStorageId),
        eq(storages.orgId, scope.orgId),
        eq(storages.userId, scope.userId),
        ne(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        isNotNull(storages.headVersionId),
      ),
    )
    .limit(1)
    .for("update", { of: storages });
  return storage ?? null;
}

async function lockPublicationJob(
  tx: Tx,
  args: PiMemoryPhase2LeaseFence,
): Promise<LockedPiMemoryPhase2PublicationJob | null> {
  const [job] = await tx
    .select({
      inputRevision: piMemoryPhase2Jobs.inputRevision,
      completedRevision: piMemoryPhase2Jobs.completedRevision,
      reconciliationRevision: piMemoryPhase2Jobs.reconciliationRevision,
      claimedSelectionDigest: piMemoryPhase2Jobs.claimedSelectionDigest,
      claimedSelectedCount: piMemoryPhase2Jobs.claimedSelectedCount,
      claimedSelectedUtf8Bytes: piMemoryPhase2Jobs.claimedSelectedUtf8Bytes,
      lastObservedHeadVersionId: piMemoryPhase2Jobs.lastObservedHeadVersionId,
    })
    .from(piMemoryPhase2Jobs)
    .where(exactLeaseCondition(args))
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  return job ?? null;
}

function publicationWriter(
  job: LockedPiMemoryPhase2PublicationJob,
  claimedRevision: number,
): PiMemoryPublicationWriter {
  return job.reconciliationRevision > job.completedRevision &&
    job.reconciliationRevision <= claimedRevision
    ? "reconciler"
    : "pi";
}

async function readPreparedStorageVersion(
  tx: Tx,
  prepared: PreparedStorageVersion,
): Promise<PreparedStorageVersion | null> {
  const [stored] = await tx
    .select({
      storageId: storageVersions.storageId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, prepared.storageId),
        eq(storageVersions.id, prepared.versionId),
      ),
    )
    .limit(1);
  return stored ?? null;
}

async function updateSelectionWatermarks(
  tx: Tx,
  scope: PiMemoryPhase2OwnerScope,
  selected: readonly PiMemoryPhase2SelectedCandidate[],
): Promise<void> {
  await tx
    .update(piMemoryStage1Candidates)
    .set({ lastSelectedSourceHistoryHash: null })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, scope.orgId),
        eq(piMemoryStage1Candidates.userId, scope.userId),
        isNotNull(piMemoryStage1Candidates.lastSelectedSourceHistoryHash),
      ),
    );
  for (const candidate of selected) {
    await tx
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: candidate.sourceHistoryHash })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, scope.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, scope.orgId),
          eq(piMemoryStage1Candidates.userId, scope.userId),
          eq(piMemoryStage1Candidates.status, "succeeded"),
          eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
          eq(
            piMemoryStage1Candidates.sourceHistoryHash,
            candidate.sourceHistoryHash,
          ),
        ),
      );
  }
}

async function completePublicationJob(
  tx: Tx,
  args: PiMemoryPhase2LeaseFence,
  metadata: PiMemoryPhase2SelectionMetadata,
  publishedVersionId?: string,
): Promise<void> {
  const [completed] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.inputRevision} = ${args.claimedRevision}
        THEN 'idle'
        ELSE 'pending'
      END`,
      completedRevision: args.claimedRevision,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      lastSucceededAt: args.currentTime,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      ...(publishedVersionId
        ? {
            lastObservedHeadVersionId: publishedVersionId,
            lastPublishedVersionId: publishedVersionId,
            lastPublishedAt: args.currentTime,
          }
        : {}),
      updatedAt: args.currentTime,
    })
    .where(
      and(
        exactLeaseCondition(args),
        eq(piMemoryPhase2Jobs.claimedSelectionDigest, metadata.digest),
        eq(piMemoryPhase2Jobs.claimedSelectedCount, metadata.count),
        eq(piMemoryPhase2Jobs.claimedSelectedUtf8Bytes, metadata.utf8Bytes),
      ),
    )
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!completed) {
    throw new Error("Locked Pi memory Phase 2 job could not be completed");
  }
}

async function recordPublicationProvenance(input: {
  readonly tx: Tx;
  readonly args: PiMemoryPhase2LeaseFence;
  readonly job: LockedPiMemoryPhase2PublicationJob;
  readonly metadata: PiMemoryPhase2SelectionMetadata;
  readonly prepared: PreparedStorageVersion;
  readonly observedHeadVersionId: string;
  readonly outcome: "published" | "conflicted";
}): Promise<void> {
  await input.tx
    .insert(piMemoryPublicationProvenance)
    .values({
      memoryStorageId: input.args.memoryStorageId,
      orgId: input.args.orgId,
      userId: input.args.userId,
      claimedRevision: input.args.claimedRevision,
      inputRevision: input.job.inputRevision,
      reconciliationRevision: input.job.reconciliationRevision,
      selectionDigest: input.metadata.digest,
      selectedCount: input.metadata.count,
      selectedUtf8Bytes: input.metadata.utf8Bytes,
      baseVersionId: input.args.claimedBaseVersionId,
      preparedVersionId: input.prepared.versionId,
      observedHeadVersionId: input.observedHeadVersionId,
      writer: publicationWriter(input.job, input.args.claimedRevision),
      outcome: input.outcome,
      size: input.prepared.size,
      archiveSize: input.prepared.archiveSize,
      fileCount: input.prepared.fileCount,
      createdAt: input.args.currentTime,
    })
    .onConflictDoNothing();
}

async function transitionPublicationConflict(
  tx: Tx,
  args: PiMemoryPhase2LeaseFence,
  job: LockedPiMemoryPhase2PublicationJob,
  currentHeadVersionId: string,
): Promise<void> {
  const observedConflictAlreadyQueued =
    job.lastObservedHeadVersionId === currentHeadVersionId &&
    job.reconciliationRevision > job.completedRevision;
  const inputRevision = observedConflictAlreadyQueued
    ? job.inputRevision
    : job.inputRevision + 1;
  const reconciliationRevision = observedConflictAlreadyQueued
    ? job.reconciliationRevision
    : inputRevision;
  const [conflicted] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: "pending",
      inputRevision,
      reconciliationRevision,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      lastObservedHeadVersionId: currentHeadVersionId,
      conflictCount: sql`${piMemoryPhase2Jobs.conflictCount} + 1`,
      lastConflictAt: args.currentTime,
      lastConflictingHeadVersionId: currentHeadVersionId,
      updatedAt: args.currentTime,
    })
    .where(exactLeaseCondition(args))
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!conflicted) {
    throw new Error("Locked Pi memory Phase 2 conflict could not be recorded");
  }
}

function snapshotSelectedCandidates(
  selected: readonly PiMemoryPhase2SelectedCandidate[],
): readonly PiMemoryPhase2SelectedCandidate[] {
  return selected.map((candidate) => {
    return {
      ...candidate,
      sourceCompletedAt: new Date(candidate.sourceCompletedAt),
    };
  });
}

export async function finalizePiMemoryPhase2Job(
  db: ApiDb,
  args: PiMemoryPhase2LeaseFence & {
    readonly selected: readonly PiMemoryPhase2SelectedCandidate[];
    readonly result:
      | { readonly kind: "no_diff" }
      | {
          readonly kind: "prepared";
          readonly version: PreparedStorageVersion;
        };
  },
): Promise<FinalizePiMemoryPhase2JobResult> {
  const selectedSnapshot = snapshotSelectedCandidates(args.selected);
  const metadata = selectionMetadata(selectedSnapshot);
  if (metadata === null) {
    return { outcome: "stale" };
  }
  const resultSnapshot =
    args.result.kind === "prepared"
      ? { kind: "prepared" as const, version: { ...args.result.version } }
      : { kind: "no_diff" as const };

  return await db.transaction(async (tx) => {
    const storage = await lockCanonicalMemoryStorage(tx, args);
    if (!storage?.headVersionId) {
      return { outcome: "stale" };
    }
    await lockPhase2CandidateSet(tx, args);
    const job = await lockPublicationJob(tx, args);
    if (!job || !selectionMatchesJob(job, metadata)) {
      return { outcome: "stale" };
    }

    if (resultSnapshot.kind === "no_diff") {
      if (storage.headVersionId !== args.claimedBaseVersionId) {
        await transitionPublicationConflict(
          tx,
          args,
          job,
          storage.headVersionId,
        );
        return {
          outcome: "conflicted",
          currentHeadVersionId: storage.headVersionId,
        };
      }
      await updateSelectionWatermarks(tx, args, selectedSnapshot);
      await completePublicationJob(tx, args, metadata);
      return {
        outcome: "no_diff",
        headVersionId: storage.headVersionId,
      };
    }

    const prepared = resultSnapshot.version;
    const registered = await readPreparedStorageVersion(tx, prepared);
    if (
      prepared.storageId !== args.memoryStorageId ||
      prepared.versionId === args.claimedBaseVersionId ||
      !registered ||
      !storageVersionMatches(registered, prepared)
    ) {
      return { outcome: "stale" };
    }

    if (storage.headVersionId !== args.claimedBaseVersionId) {
      await recordPublicationProvenance({
        tx,
        args,
        job,
        metadata,
        prepared,
        observedHeadVersionId: storage.headVersionId,
        outcome: "conflicted",
      });
      await transitionPublicationConflict(tx, args, job, storage.headVersionId);
      return {
        outcome: "conflicted",
        currentHeadVersionId: storage.headVersionId,
      };
    }

    const [published] = await tx
      .update(storages)
      .set({
        headVersionId: prepared.versionId,
        size: prepared.size,
        fileCount: prepared.fileCount,
        updatedAt: args.currentTime,
      })
      .where(
        and(
          eq(storages.id, args.memoryStorageId),
          eq(storages.orgId, args.orgId),
          eq(storages.userId, args.userId),
          ne(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          eq(storages.headVersionId, args.claimedBaseVersionId),
        ),
      )
      .returning({
        id: storages.id,
        orgId: storages.orgId,
        userId: storages.userId,
        name: storages.name,
      });
    if (!published) {
      throw new Error("Locked Pi memory Phase 2 HEAD CAS did not publish");
    }

    await recordPublicationProvenance({
      tx,
      args,
      job,
      metadata,
      prepared,
      observedHeadVersionId: prepared.versionId,
      outcome: "published",
    });
    await enqueueMemorySummaryProjection({
      db: tx,
      storage: published,
      storageVersionId: prepared.versionId,
    });
    await updateSelectionWatermarks(tx, args, selectedSnapshot);
    await completePublicationJob(tx, args, metadata, prepared.versionId);
    return {
      outcome: "published",
      publishedVersionId: prepared.versionId,
    };
  });
}
