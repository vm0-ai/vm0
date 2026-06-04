import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command, computed, type Computed } from "ccstate";
import { and, asc, desc, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import {
  localDateLabel,
  localMidnightUtc,
  resolveUserTimezones,
} from "./local-day";
import {
  computeMemoryChangeSet,
  type MemoryChangeSet,
} from "./memory-activity-diff.service";
import { generateMemoryDaySummary } from "./memory-activity-summarize.service";
import { settle } from "../utils";

const L = logger("CronSummarizeMemory");

// Most closed local days a single run will summarize. Bounds missed-cron
// recovery (and guards against pathologically old windows) so one run stays
// cheap; older un-summarized days are simply not backfilled.
const MAX_RECOVERY_DAYS = 14;

type SummarizeMemoryResult =
  | { readonly skipped: true }
  | { readonly summarized: number };

interface MemoryStorageRow {
  readonly orgId: string;
  readonly userId: string;
  readonly storageId: string;
}

interface MemoryVersionRow {
  readonly id: string;
  readonly s3Key: string;
  readonly createdAt: Date;
}

interface LastSummaryRow {
  readonly date: string;
  readonly toVersionId: string;
}

interface ClosedDayWindow {
  readonly targetDate: string;
  readonly dayEnd: Date;
}

/** The next calendar date (YYYY-MM-DD) after `dateLabel`. */
function nextDateLabel(dateLabel: string): string {
  const next = new Date(`${dateLabel}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The closed (already-elapsed) local days in `[windowStart, now)`, one window
 * per day. The current local day is excluded because it is still open. Each
 * window's `dayEnd` is the UTC instant of the next local midnight, so a version
 * is "in" the day when its createdAt is strictly before dayEnd.
 *
 * Iteration is by calendar date (stable across hosts), capped at the recovery
 * window so a stale/never-summarized baseline can't expand into a huge list.
 */
function closedLocalDays(
  timezone: string,
  windowStart: Date,
  now: Date,
): ClosedDayWindow[] {
  const currentDate = localDateLabel(timezone, now);
  const earliest = new Date(
    localMidnightUtc(timezone, currentDate).getTime() -
      MAX_RECOVERY_DAYS * 24 * 3_600_000,
  );
  const effectiveStart = windowStart > earliest ? windowStart : earliest;

  const windows: ClosedDayWindow[] = [];
  let date = localDateLabel(timezone, effectiveStart);
  while (date < currentDate) {
    const nextDate = nextDateLabel(date);
    windows.push({
      targetDate: date,
      dayEnd: localMidnightUtc(timezone, nextDate),
    });
    date = nextDate;
  }

  return windows;
}

async function loadMemoryStorages(
  db: Db,
  signal: AbortSignal,
): Promise<MemoryStorageRow[]> {
  const rows = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      storageId: storages.id,
    })
    .from(storages)
    .where(
      and(
        eq(storages.name, MEMORY_ARTIFACT_NAME),
        eq(storages.type, "artifact"),
      ),
    );
  signal.throwIfAborted();
  return rows;
}

async function loadVersions(
  db: Db,
  storageId: string,
  signal: AbortSignal,
): Promise<MemoryVersionRow[]> {
  const rows = await db
    .select({
      id: storageVersions.id,
      s3Key: storageVersions.s3Key,
      createdAt: storageVersions.createdAt,
    })
    .from(storageVersions)
    .where(eq(storageVersions.storageId, storageId))
    .orderBy(asc(storageVersions.createdAt));
  signal.throwIfAborted();
  return rows;
}

async function loadLastSummary(
  db: Db,
  orgId: string,
  userId: string,
  signal: AbortSignal,
): Promise<LastSummaryRow | null> {
  const [row] = await db
    .select({
      date: memoryChangeSummaries.date,
      toVersionId: memoryChangeSummaries.toVersionId,
    })
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, orgId),
        eq(memoryChangeSummaries.userId, userId),
      ),
    )
    .orderBy(desc(memoryChangeSummaries.date))
    .limit(1);
  signal.throwIfAborted();
  return row ?? null;
}

/** The latest version whose createdAt is strictly before `instant`. */
function lastVersionBefore(
  versions: readonly MemoryVersionRow[],
  instant: Date,
): MemoryVersionRow | null {
  let result: MemoryVersionRow | null = null;
  for (const version of versions) {
    if (version.createdAt < instant) {
      result = version;
    } else {
      break;
    }
  }
  return result;
}

async function persistSummary(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly date: string;
    readonly fromVersionId: string;
    readonly toVersionId: string;
    readonly summary: string | null;
    readonly changeSet: MemoryChangeSet;
    readonly createdAt: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(memoryChangeSummaries)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        date: args.date,
        fromVersionId: args.fromVersionId,
        toVersionId: args.toVersionId,
        summary: args.summary,
        createdAt: args.createdAt,
      })
      .onConflictDoUpdate({
        target: [
          memoryChangeSummaries.orgId,
          memoryChangeSummaries.userId,
          memoryChangeSummaries.date,
        ],
        set: {
          fromVersionId: args.fromVersionId,
          toVersionId: args.toVersionId,
          summary: args.summary,
          createdAt: args.createdAt,
        },
      })
      .returning({ id: memoryChangeSummaries.id });

    if (!inserted) {
      throw new Error("Failed to upsert memory change summary");
    }
    const summaryId = inserted.id;
    await tx
      .delete(memoryChangeItems)
      .where(eq(memoryChangeItems.summaryId, summaryId));
    await tx.insert(memoryChangeItems).values(
      args.changeSet.items.map((item) => {
        return {
          summaryId,
          kind: item.kind,
          title: item.title,
          description: item.description,
          filePath: item.filePath,
          beforeSnippet: item.beforeSnippet,
          afterSnippet: item.afterSnippet,
        };
      }),
    );
  });
  signal.throwIfAborted();
}

function summarizeUserMemory(
  db: Db,
  storage: MemoryStorageRow,
  timezone: string,
  now: Date,
  signal: AbortSignal,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const versions = await loadVersions(db, storage.storageId, signal);
    const firstVersion = versions[0];
    if (!firstVersion) {
      return 0;
    }

    const lastSummary = await loadLastSummary(
      db,
      storage.orgId,
      storage.userId,
      signal,
    );

    const latestVersion = versions[versions.length - 1] ?? firstVersion;
    if (lastSummary && latestVersion.id === lastSummary.toVersionId) {
      // Memory has not advanced since the last summary: nothing new can fall
      // into a newly-closed day. Skip without any S3 work.
      return 0;
    }

    // Baseline = version current at the start of the window. On the first ever
    // run it's the user's first version (older memory is not re-emitted as
    // "learned today"); otherwise it's the previous summary's toVersion. The
    // window starts at the first version's day, or the day after the last
    // summarized day.
    let baseline = firstVersion;
    let windowStart = firstVersion.createdAt;
    if (lastSummary) {
      const prior = versions.find((version) => {
        return version.id === lastSummary.toVersionId;
      });
      if (prior) {
        baseline = prior;
      }
      // Resume from the local day after the one already summarized.
      windowStart = localMidnightUtc(timezone, nextDateLabel(lastSummary.date));
    }

    const days = closedLocalDays(timezone, windowStart, now);
    let summarized = 0;

    for (const day of days) {
      const toVersion = lastVersionBefore(versions, day.dayEnd);
      if (!toVersion || toVersion.id === baseline.id) {
        // No version through this day's close, or unchanged since the
        // baseline: skip entirely (no LLM call, no row).
        continue;
      }

      const changeSet = await get(
        computeMemoryChangeSet(baseline.s3Key, toVersion.s3Key),
      );
      signal.throwIfAborted();

      const fromVersionId = baseline.id;
      // Carry the baseline forward so a quiet later day re-diffs from here.
      baseline = toVersion;

      if (!changeSet.changed) {
        continue;
      }

      const summaryResult = await settle(generateMemoryDaySummary(changeSet));
      if (!summaryResult.ok) {
        L.warn("Memory day summary generation failed", {
          orgId: storage.orgId,
          userId: storage.userId,
          date: day.targetDate,
          err: summaryResult.error,
        });
      }

      await persistSummary(
        db,
        {
          orgId: storage.orgId,
          userId: storage.userId,
          date: day.targetDate,
          fromVersionId,
          toVersionId: toVersion.id,
          summary: summaryResult.ok ? summaryResult.value : null,
          changeSet,
          createdAt: now,
        },
        signal,
      );
      summarized++;
    }

    return summarized;
  });
}

export const summarizeMemory$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<SummarizeMemoryResult> => {
    const db = set(writeDb$);
    const now = nowDate();

    const memoryStorages = await loadMemoryStorages(db, signal);
    if (memoryStorages.length === 0) {
      L.debug("No memory artifacts to summarize");
      return { skipped: true };
    }

    const timezoneMap = await resolveUserTimezones(
      db,
      memoryStorages.map((row) => {
        return { orgId: row.orgId, userId: row.userId };
      }),
      signal,
    );

    let summarized = 0;
    for (const storage of memoryStorages) {
      const timezone =
        timezoneMap.get(`${storage.orgId}:${storage.userId}`) ?? "UTC";
      summarized += await get(
        summarizeUserMemory(db, storage, timezone, now, signal),
      );
      signal.throwIfAborted();
    }

    L.debug("Summarized memory changes", { summarized });
    if (summarized === 0) {
      return { skipped: true };
    }
    return { summarized };
  },
);
