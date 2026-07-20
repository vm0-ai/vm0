import { randomUUID } from "node:crypto";

import type {
  StorageArchiveSizeBackfillResponse,
  StorageArchiveSizeBackfillStatusResponse,
} from "@vm0/api-contracts/contracts/cron";
import { storageArchiveSizeBackfillWork } from "@vm0/db/schema/storage-archive-size-backfill";
import { storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, asc, count, eq, isNull, lte, sql } from "drizzle-orm";

import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { s3ObjectHead } from "../external/s3";
import { settle } from "../utils";

const BATCH_SIZE = 25;
const WORKER_COUNT = 4;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const L = logger("CronStorageArchiveSizeBackfill");

type ActiveBackfillResponse = Extract<
  StorageArchiveSizeBackfillResponse,
  { state: "active" }
>;

interface StorageArchiveClaim {
  readonly storageVersionId: string;
  readonly s3Key: string;
  readonly fileCount: number;
  readonly claimToken: string;
}

type StorageArchiveOutcome =
  | {
      readonly kind: "positive";
      readonly archiveSize: number;
    }
  | {
      readonly kind: "intentionalEmpty";
      readonly archiveSize: 0;
    }
  | {
      readonly kind: "missing";
      readonly errorCode: "archive-not-found";
    }
  | {
      readonly kind: "invalid";
      readonly errorCode:
        | "content-length-missing"
        | "content-length-non-positive"
        | "content-length-unsafe";
    }
  | {
      readonly kind: "failed";
      readonly errorCode: "head-request-failed";
    };

type BatchOutcome =
  | StorageArchiveOutcome["kind"]
  | "alreadyCompleted"
  | "superseded";

interface BatchCounts {
  selected: number;
  positive: number;
  intentionalEmpty: number;
  alreadyCompleted: number;
  superseded: number;
  missing: number;
  invalid: number;
  failed: number;
}

interface ReservedBatch {
  readonly batchToken: string;
  readonly claims: readonly StorageArchiveClaim[];
}

interface ArchiveSizeStatusCounts {
  readonly totalVersions: number;
  readonly positiveArchives: number;
  readonly intentionalEmptyArchives: number;
  readonly remaining: number;
  readonly negativeArchives: number;
  readonly nonEmptyZeroArchives: number;
  readonly unresolved: {
    readonly missing: number;
    readonly invalid: number;
    readonly failed: number;
  };
}

function emptyBatchCounts(selected: number): BatchCounts {
  return {
    selected,
    positive: 0,
    intentionalEmpty: 0,
    alreadyCompleted: 0,
    superseded: 0,
    missing: 0,
    invalid: 0,
    failed: 0,
  };
}

function incrementBatchCount(counts: BatchCounts, outcome: BatchOutcome): void {
  switch (outcome) {
    case "positive": {
      counts.positive += 1;
      return;
    }
    case "intentionalEmpty": {
      counts.intentionalEmpty += 1;
      return;
    }
    case "alreadyCompleted": {
      counts.alreadyCompleted += 1;
      return;
    }
    case "superseded": {
      counts.superseded += 1;
      return;
    }
    case "missing": {
      counts.missing += 1;
      return;
    }
    case "invalid": {
      counts.invalid += 1;
      return;
    }
    case "failed": {
      counts.failed += 1;
      return;
    }
  }
}

function isUndefinedTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "42P01") {
    return true;
  }
  if (!("cause" in error)) {
    return false;
  }
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "42P01"
  );
}

const resolveStorageArchiveOutcome$ = command(
  async (
    { get },
    claim: StorageArchiveClaim,
    signal: AbortSignal,
  ): Promise<StorageArchiveOutcome> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const result = await settle(
      get(s3ObjectHead(bucket, `${claim.s3Key}/archive.tar.gz`)),
      signal,
    );
    if (!result.ok) {
      return { kind: "failed", errorCode: "head-request-failed" };
    }

    if (result.value.kind === "missing") {
      return claim.fileCount === 0
        ? { kind: "intentionalEmpty", archiveSize: 0 }
        : { kind: "missing", errorCode: "archive-not-found" };
    }

    const contentLength = result.value.contentLength;
    if (contentLength === undefined) {
      return { kind: "invalid", errorCode: "content-length-missing" };
    }
    if (contentLength <= 0) {
      return { kind: "invalid", errorCode: "content-length-non-positive" };
    }
    if (!Number.isSafeInteger(contentLength)) {
      return { kind: "invalid", errorCode: "content-length-unsafe" };
    }
    return { kind: "positive", archiveSize: contentLength };
  },
);

const processStorageArchiveClaim$ = command(
  async (
    { set },
    claim: StorageArchiveClaim,
    signal: AbortSignal,
  ): Promise<BatchOutcome> => {
    const outcome = await set(resolveStorageArchiveOutcome$, claim, signal);
    const db = set(writeDb$);

    if (outcome.kind === "positive" || outcome.kind === "intentionalEmpty") {
      const result = await db.transaction(async (tx) => {
        const [version] = await tx
          .select({ archiveSize: storageVersions.archiveSize })
          .from(storageVersions)
          .where(eq(storageVersions.id, claim.storageVersionId))
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (!version || version.archiveSize !== null) {
          await tx
            .delete(storageArchiveSizeBackfillWork)
            .where(
              and(
                eq(
                  storageArchiveSizeBackfillWork.storageVersionId,
                  claim.storageVersionId,
                ),
                eq(storageArchiveSizeBackfillWork.claimToken, claim.claimToken),
              ),
            );
          signal.throwIfAborted();
          return "alreadyCompleted" as const;
        }

        const [ownedClaim] = await tx
          .select({
            storageVersionId: storageArchiveSizeBackfillWork.storageVersionId,
          })
          .from(storageArchiveSizeBackfillWork)
          .where(
            and(
              eq(
                storageArchiveSizeBackfillWork.storageVersionId,
                claim.storageVersionId,
              ),
              eq(storageArchiveSizeBackfillWork.claimToken, claim.claimToken),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!ownedClaim) {
          return "superseded" as const;
        }

        await tx
          .update(storageVersions)
          .set({ archiveSize: outcome.archiveSize })
          .where(
            and(
              eq(storageVersions.id, claim.storageVersionId),
              isNull(storageVersions.archiveSize),
            ),
          );
        signal.throwIfAborted();

        await tx
          .delete(storageArchiveSizeBackfillWork)
          .where(
            and(
              eq(
                storageArchiveSizeBackfillWork.storageVersionId,
                claim.storageVersionId,
              ),
              eq(storageArchiveSizeBackfillWork.claimToken, claim.claimToken),
            ),
          );
        signal.throwIfAborted();
        return outcome.kind;
      });
      signal.throwIfAborted();
      return result;
    }

    const result = await db.transaction(async (tx) => {
      const [version] = await tx
        .select({ archiveSize: storageVersions.archiveSize })
        .from(storageVersions)
        .where(eq(storageVersions.id, claim.storageVersionId))
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!version || version.archiveSize !== null) {
        await tx
          .delete(storageArchiveSizeBackfillWork)
          .where(
            and(
              eq(
                storageArchiveSizeBackfillWork.storageVersionId,
                claim.storageVersionId,
              ),
              eq(storageArchiveSizeBackfillWork.claimToken, claim.claimToken),
            ),
          );
        signal.throwIfAborted();
        return "alreadyCompleted" as const;
      }

      const [updated] = await tx
        .update(storageArchiveSizeBackfillWork)
        .set({
          leaseExpiresAt: nowDate(),
          outcome: outcome.kind,
          errorCode: outcome.errorCode,
        })
        .where(
          and(
            eq(
              storageArchiveSizeBackfillWork.storageVersionId,
              claim.storageVersionId,
            ),
            eq(storageArchiveSizeBackfillWork.claimToken, claim.claimToken),
          ),
        )
        .returning({
          storageVersionId: storageArchiveSizeBackfillWork.storageVersionId,
        });
      signal.throwIfAborted();
      return updated ? outcome.kind : ("superseded" as const);
    });
    signal.throwIfAborted();
    return result;
  },
);

const processStorageArchiveClaimWorker$ = command(
  async (
    { set },
    claims: readonly StorageArchiveClaim[],
    workerIndex: number,
    workerCount: number,
    signal: AbortSignal,
  ): Promise<readonly BatchOutcome[]> => {
    const outcomes: BatchOutcome[] = [];
    for (const [claimIndex, claim] of claims.entries()) {
      if (claimIndex % workerCount !== workerIndex) {
        continue;
      }
      outcomes.push(await set(processStorageArchiveClaim$, claim, signal));
    }
    return outcomes;
  },
);

const reserveStorageArchiveSizeBatch$ = command(
  async ({ set }, signal: AbortSignal): Promise<ReservedBatch> => {
    const db = set(writeDb$);
    const batchToken = randomUUID();
    const startedAt = nowDate();
    const leaseExpiresAt = new Date(startedAt.getTime() + CLAIM_LEASE_MS);

    const claims = await db.transaction(async (tx) => {
      const untouched = await tx
        .select({
          storageVersionId: storageVersions.id,
          s3Key: storageVersions.s3Key,
          fileCount: storageVersions.fileCount,
        })
        .from(storageVersions)
        .leftJoin(
          storageArchiveSizeBackfillWork,
          eq(
            storageArchiveSizeBackfillWork.storageVersionId,
            storageVersions.id,
          ),
        )
        .where(
          and(
            isNull(storageVersions.archiveSize),
            isNull(storageArchiveSizeBackfillWork.storageVersionId),
          ),
        )
        .orderBy(asc(storageVersions.id))
        .limit(BATCH_SIZE)
        .for("update", { of: storageVersions, skipLocked: true });
      signal.throwIfAborted();

      const retrySlots = BATCH_SIZE - untouched.length;
      const retries =
        retrySlots === 0
          ? []
          : await tx
              .select({
                storageVersionId: storageVersions.id,
                s3Key: storageVersions.s3Key,
                fileCount: storageVersions.fileCount,
              })
              .from(storageVersions)
              .innerJoin(
                storageArchiveSizeBackfillWork,
                eq(
                  storageArchiveSizeBackfillWork.storageVersionId,
                  storageVersions.id,
                ),
              )
              .where(
                and(
                  isNull(storageVersions.archiveSize),
                  lte(storageArchiveSizeBackfillWork.leaseExpiresAt, startedAt),
                ),
              )
              .orderBy(
                asc(storageArchiveSizeBackfillWork.attemptCount),
                asc(storageVersions.id),
              )
              .limit(retrySlots)
              .for("update", { of: storageVersions, skipLocked: true });
      signal.throwIfAborted();

      const candidates = [...untouched, ...retries];
      if (candidates.length > 0) {
        await tx
          .insert(storageArchiveSizeBackfillWork)
          .values(
            candidates.map((candidate) => {
              return {
                storageVersionId: candidate.storageVersionId,
                claimToken: batchToken,
                leaseExpiresAt,
                attemptCount: 1,
                lastAttemptAt: startedAt,
                outcome: null,
                errorCode: null,
              };
            }),
          )
          .onConflictDoUpdate({
            target: storageArchiveSizeBackfillWork.storageVersionId,
            set: {
              claimToken: batchToken,
              leaseExpiresAt,
              attemptCount: sql`${storageArchiveSizeBackfillWork.attemptCount} + 1`,
              lastAttemptAt: startedAt,
              outcome: null,
              errorCode: null,
            },
          });
        signal.throwIfAborted();
      }

      return candidates.map((candidate) => {
        return { ...candidate, claimToken: batchToken };
      });
    });
    signal.throwIfAborted();
    return { batchToken, claims };
  },
);

const runStorageArchiveSizeBackfill$ = command(
  async ({ set }, signal: AbortSignal): Promise<ActiveBackfillResponse> => {
    const { batchToken, claims } = await set(
      reserveStorageArchiveSizeBatch$,
      signal,
    );

    const workerCount = Math.min(WORKER_COUNT, claims.length);
    const workerOutcomes = await Promise.all(
      Array.from({ length: workerCount }, (_, workerIndex) => {
        return set(
          processStorageArchiveClaimWorker$,
          claims,
          workerIndex,
          workerCount,
          signal,
        );
      }),
    );
    signal.throwIfAborted();

    const counts = emptyBatchCounts(claims.length);
    for (const outcomes of workerOutcomes) {
      for (const outcome of outcomes) {
        incrementBatchCount(counts, outcome);
      }
    }

    L.debug("Storage archive size backfill batch completed", {
      batchToken,
      ...counts,
    });

    return {
      state: "active",
      batchToken,
      ...counts,
    };
  },
);

const readStorageArchiveSizeStatusCounts$ = command(
  async ({ set }, signal: AbortSignal): Promise<ArchiveSizeStatusCounts> => {
    const db = set(writeDb$);
    const [counts] = await db
      .select({
        totalVersions: count(),
        positiveArchives: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} > 0
          )::int`.mapWith(pgIntegerDecoder),
        intentionalEmptyArchives: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} = 0
              AND ${storageVersions.fileCount} = 0
          )::int`.mapWith(pgIntegerDecoder),
        remaining: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} IS NULL
          )::int`.mapWith(pgIntegerDecoder),
        negativeArchives: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} < 0
          )::int`.mapWith(pgIntegerDecoder),
        nonEmptyZeroArchives: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} = 0
              AND ${storageVersions.fileCount} <> 0
          )::int`.mapWith(pgIntegerDecoder),
        missing: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} IS NULL
              AND ${storageArchiveSizeBackfillWork.outcome} = 'missing'
          )::int`.mapWith(pgIntegerDecoder),
        invalid: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} IS NULL
              AND ${storageArchiveSizeBackfillWork.outcome} = 'invalid'
          )::int`.mapWith(pgIntegerDecoder),
        failed: sql`COUNT(*) FILTER (
            WHERE ${storageVersions.archiveSize} IS NULL
              AND ${storageArchiveSizeBackfillWork.outcome} = 'failed'
          )::int`.mapWith(pgIntegerDecoder),
      })
      .from(storageVersions)
      .leftJoin(
        storageArchiveSizeBackfillWork,
        eq(storageArchiveSizeBackfillWork.storageVersionId, storageVersions.id),
      );
    signal.throwIfAborted();

    if (!counts) {
      throw new Error("Storage archive size status aggregate returned no row");
    }

    return {
      totalVersions: counts.totalVersions,
      positiveArchives: counts.positiveArchives,
      intentionalEmptyArchives: counts.intentionalEmptyArchives,
      remaining: counts.remaining,
      negativeArchives: counts.negativeArchives,
      nonEmptyZeroArchives: counts.nonEmptyZeroArchives,
      unresolved: {
        missing: counts.missing,
        invalid: counts.invalid,
        failed: counts.failed,
      },
    };
  },
);

const readStorageArchiveSizeBackfillStatus$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<
    Extract<StorageArchiveSizeBackfillStatusResponse, { state: "active" }>
  > => {
    const counts = await set(readStorageArchiveSizeStatusCounts$, signal);
    const unresolvedTotal =
      counts.unresolved.missing +
      counts.unresolved.invalid +
      counts.unresolved.failed;

    return {
      state: "active",
      ...counts,
      unattemptedOrInFlight: counts.remaining - unresolvedTotal,
      complete:
        counts.remaining === 0 &&
        unresolvedTotal === 0 &&
        counts.negativeArchives === 0 &&
        counts.nonEmptyZeroArchives === 0,
    };
  },
);

export const backfillStorageArchiveSizes$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<StorageArchiveSizeBackfillResponse> => {
    const result = await settle(
      set(runStorageArchiveSizeBackfill$, signal),
      signal,
    );
    if (result.ok) {
      return result.value;
    }
    if (isUndefinedTableError(result.error)) {
      return { state: "retired" };
    }
    throw result.error;
  },
);

export const storageArchiveSizeBackfillStatus$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<StorageArchiveSizeBackfillStatusResponse> => {
    const result = await settle(
      set(readStorageArchiveSizeBackfillStatus$, signal),
      signal,
    );
    if (result.ok) {
      return result.value;
    }
    if (isUndefinedTableError(result.error)) {
      return { state: "retired" };
    }
    throw result.error;
  },
);
