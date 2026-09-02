import { createHash, randomUUID } from "node:crypto";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";
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
  or,
  sql,
} from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

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
  readonly sourceHistoryHash: string;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug: string | null;
}

interface ClaimedPiMemoryPhase2Job extends PiMemoryPhase2OwnerScope {
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly claimedRevision: number;
  readonly selected: readonly PiMemoryPhase2SelectedCandidate[];
}

interface ClaimPiMemoryPhase2JobArgs {
  readonly currentTime: Date;
  readonly scope?: PiMemoryPhase2OwnerScope;
}

interface PiMemoryPhase2LeaseFence extends PiMemoryPhase2OwnerScope {
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly currentTime: Date;
}

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
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
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
      sourceHistoryHash: candidate.sourceHistoryHash,
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

export async function claimPiMemoryPhase2Job(
  db: ApiDb,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<ClaimedPiMemoryPhase2Job | null> {
  return await db.transaction(async (tx) => {
    const job = await lockNextClaimableJob(tx, args);
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

    const scope = {
      memoryStorageId: job.memoryStorageId,
      orgId: job.orgId,
      userId: job.userId,
    };
    const selected = await selectClaimCandidates(tx, scope, args.currentTime);
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
        leaseToken,
        leaseExpiresAt,
        retryCount,
        retryAt: null,
        lastErrorClass: null,
        claimedSelectionDigest: metadata.digest,
        claimedSelectedCount: metadata.count,
        claimedSelectedUtf8Bytes: metadata.utf8Bytes,
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

async function lockNextClaimableJob(
  tx: Tx,
  args: ClaimPiMemoryPhase2JobArgs,
): Promise<LockedClaimableJob | null> {
  const cooldownBoundary = new Date(
    args.currentTime.getTime() - PI_MEMORY_PHASE2_SUCCESS_COOLDOWN_MS,
  );
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
    .innerJoin(
      storages,
      and(
        eq(storages.id, piMemoryPhase2Jobs.memoryStorageId),
        eq(storages.orgId, piMemoryPhase2Jobs.orgId),
        eq(storages.userId, piMemoryPhase2Jobs.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .where(
      and(
        gt(
          piMemoryPhase2Jobs.inputRevision,
          piMemoryPhase2Jobs.completedRevision,
        ),
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
          isNull(piMemoryPhase2Jobs.lastSucceededAt),
          lte(piMemoryPhase2Jobs.lastSucceededAt, cooldownBoundary),
        ),
        claimScopeCondition(args.scope),
      ),
    )
    .orderBy(
      asc(piMemoryPhase2Jobs.updatedAt),
      asc(piMemoryPhase2Jobs.memoryStorageId),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs, skipLocked: true });
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

export async function succeedPiMemoryPhase2Job(
  db: ApiDb,
  args: PiMemoryPhase2LeaseFence & {
    readonly selected: readonly PiMemoryPhase2SelectedCandidate[];
  },
): Promise<boolean> {
  const selectedSnapshot = args.selected.map((candidate) => {
    return { ...candidate };
  });
  const metadata = selectionMetadata(selectedSnapshot);
  if (metadata === null) {
    return false;
  }

  return await db.transaction(async (tx) => {
    await tx
      .select({ piSessionId: piMemoryStage1Candidates.piSessionId })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, args.orgId),
          eq(piMemoryStage1Candidates.userId, args.userId),
        ),
      )
      .orderBy(asc(piMemoryStage1Candidates.piSessionId))
      .for("update", { of: piMemoryStage1Candidates });
    const [job] = await tx
      .select({
        claimedSelectionDigest: piMemoryPhase2Jobs.claimedSelectionDigest,
        claimedSelectedCount: piMemoryPhase2Jobs.claimedSelectedCount,
        claimedSelectedUtf8Bytes: piMemoryPhase2Jobs.claimedSelectedUtf8Bytes,
      })
      .from(piMemoryPhase2Jobs)
      .where(exactLeaseCondition(args))
      .limit(1)
      .for("update", { of: piMemoryPhase2Jobs });
    if (!job || !selectionMatchesJob(job, metadata)) {
      return false;
    }

    await tx
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: null })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, args.orgId),
          eq(piMemoryStage1Candidates.userId, args.userId),
          isNotNull(piMemoryStage1Candidates.lastSelectedSourceHistoryHash),
        ),
      );
    for (const selected of selectedSnapshot) {
      await tx
        .update(piMemoryStage1Candidates)
        .set({
          lastSelectedSourceHistoryHash: selected.sourceHistoryHash,
        })
        .where(
          and(
            eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
            eq(piMemoryStage1Candidates.orgId, args.orgId),
            eq(piMemoryStage1Candidates.userId, args.userId),
            eq(piMemoryStage1Candidates.status, "succeeded"),
            eq(piMemoryStage1Candidates.piSessionId, selected.piSessionId),
            eq(
              piMemoryStage1Candidates.sourceHistoryHash,
              selected.sourceHistoryHash,
            ),
          ),
        );
    }

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
        leaseToken: null,
        leaseExpiresAt: null,
        retryCount: 0,
        retryAt: null,
        lastErrorClass: null,
        lastSucceededAt: args.currentTime,
        claimedSelectionDigest: null,
        claimedSelectedCount: null,
        claimedSelectedUtf8Bytes: null,
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
    return true;
  });
}
