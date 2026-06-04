import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command, computed, type Computed } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
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
const MEMORY_SUMMARY_LOOKBACK_DAYS = 7;

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

function addDateLabelDays(dateLabel: string, days: number): string {
  const date = new Date(`${dateLabel}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The previous calendar date (YYYY-MM-DD) before `dateLabel`. */
function previousDateLabel(dateLabel: string): string {
  return addDateLabelDays(dateLabel, -1);
}

/** The next calendar date (YYYY-MM-DD) after `dateLabel`. */
function nextDateLabel(dateLabel: string): string {
  return addDateLabelDays(dateLabel, 1);
}

function recentClosedDateLabels(todayLabel: string): readonly string[] {
  const labels: string[] = [];
  let cursor = todayLabel;
  for (let index = 0; index < MEMORY_SUMMARY_LOOKBACK_DAYS; index++) {
    cursor = previousDateLabel(cursor);
    labels.push(cursor);
  }
  return labels.reverse();
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

async function summaryExists(
  db: Db,
  orgId: string,
  userId: string,
  date: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryChangeSummaries.id })
    .from(memoryChangeSummaries)
    .where(
      and(
        eq(memoryChangeSummaries.orgId, orgId),
        eq(memoryChangeSummaries.userId, userId),
        eq(memoryChangeSummaries.date, date),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return row !== undefined;
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
    readonly fromVersionId: string | null;
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
    if (args.changeSet.items.length > 0) {
      await tx.insert(memoryChangeItems).values(
        args.changeSet.items.map((item) => {
          return {
            summaryId,
            kind: item.kind,
            title: item.title,
            description: item.description,
            filePath: item.filePath,
            diff: item.diff,
          };
        }),
      );
    }
  });
  signal.throwIfAborted();
}

/**
 * Summarize a single user's memory for the seven most-recently-closed local
 * days. Each missing day is compared against the day before it, so the first
 * run backfills a daily timeline instead of one combined multi-day diff.
 *
 * The baseline for a date is the version current at that date's local
 * midnight. The target is the version current at the next local midnight. A
 * null baseline means the user's memory first appeared during that day. Days
 * with no changes still get a quiet card once memory exists, while days before
 * the user's first memory version are skipped.
 */
function summarizeUserMemory(
  db: Db,
  storage: MemoryStorageRow,
  timezone: string,
  now: Date,
  signal: AbortSignal,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const todayLabel = localDateLabel(timezone, now);
    const dateLabels = recentClosedDateLabels(todayLabel);
    const versions = await loadVersions(db, storage.storageId, signal);

    let summarized = 0;
    for (const dateLabel of dateLabels) {
      // Idempotent: if a date already has a summary row, do nothing.
      if (
        await summaryExists(
          db,
          storage.orgId,
          storage.userId,
          dateLabel,
          signal,
        )
      ) {
        continue;
      }

      const dayStart = localMidnightUtc(timezone, dateLabel);
      const dayEnd = localMidnightUtc(timezone, nextDateLabel(dateLabel));

      // State at the end of the day. Null means the user had no memory through
      // that date, so there is no card to show.
      const toVersion = lastVersionBefore(versions, dayEnd);
      if (!toVersion) {
        continue;
      }

      // State at the start of the day (= end of the day before). Null means
      // the user's memory first appeared during this date.
      const baseline = lastVersionBefore(versions, dayStart);

      const changeSet =
        baseline?.id === toVersion.id
          ? { items: [], changed: false }
          : await get(
              computeMemoryChangeSet(baseline?.s3Key ?? null, toVersion.s3Key),
            );
      signal.throwIfAborted();

      let summary: string | null = null;
      if (changeSet.changed) {
        const summaryResult = await settle(generateMemoryDaySummary(changeSet));
        if (summaryResult.ok) {
          summary = summaryResult.value;
        } else {
          L.warn("Memory day summary generation failed", {
            orgId: storage.orgId,
            userId: storage.userId,
            date: dateLabel,
            err: summaryResult.error,
          });
        }
      }

      await persistSummary(
        db,
        {
          orgId: storage.orgId,
          userId: storage.userId,
          date: dateLabel,
          fromVersionId: baseline?.id ?? null,
          toVersionId: toVersion.id,
          summary,
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

/**
 * Whether the Memory Viewer feature is enabled for this org/user. Generation
 * must match UI visibility exactly: a user who cannot see the Memory page must
 * not have summaries generated (and burn LLM credits). The context mirrors what
 * the platform `featureSwitch$` signal evaluates — registry identity plus the
 * per-(org,user) DB overrides — so a manually enabled override is honored too.
 */
function memoryViewerEnabled(
  db: Db,
  orgId: string,
  userId: string,
): Computed<Promise<boolean>> {
  return computed(async (): Promise<boolean> => {
    const ctx = await loadUserFeatureSwitchContext(db, orgId, userId);
    return isFeatureEnabled(FeatureSwitchKey.MemoryViewer, ctx);
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

    // Cache the feature-switch evaluation per distinct org/user so a user with
    // several artifacts (or a repeated org) is only evaluated once.
    const enabledCache = new Map<string, boolean>();

    let summarized = 0;
    for (const storage of memoryStorages) {
      const cacheKey = `${storage.orgId}:${storage.userId}`;
      let enabled = enabledCache.get(cacheKey);
      if (enabled === undefined) {
        enabled = await get(
          memoryViewerEnabled(db, storage.orgId, storage.userId),
        );
        signal.throwIfAborted();
        enabledCache.set(cacheKey, enabled);
      }
      if (!enabled) {
        // User cannot see the Memory page: skip generation entirely.
        continue;
      }

      const timezone = timezoneMap.get(cacheKey) ?? "UTC";
      // Isolate each user: one user's malformed data (e.g. invalid memory
      // frontmatter) must not abort the whole run for everyone. AbortError
      // still propagates through `settle`, so a genuine cancellation stops the
      // loop instead of being swallowed.
      const result = await settle(
        get(summarizeUserMemory(db, storage, timezone, now, signal)),
        signal,
      );
      if (result.ok) {
        summarized += result.value;
      } else {
        L.warn("Failed to summarize user memory", {
          orgId: storage.orgId,
          userId: storage.userId,
          err: result.error,
        });
      }
      signal.throwIfAborted();
    }

    L.debug("Summarized memory changes", { summarized });
    if (summarized === 0) {
      return { skipped: true };
    }
    return { summarized };
  },
);
