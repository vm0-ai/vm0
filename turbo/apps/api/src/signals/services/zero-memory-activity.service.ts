import { computed, type Computed } from "ccstate";
import {
  memoryChangeItems,
  type MemoryChangeDiff,
} from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";

import { db$ } from "../external/db";

interface MemoryActivityItem {
  readonly filePath: string;
  readonly diff: MemoryChangeDiff;
}

interface MemoryActivityEntry {
  readonly date: string;
  readonly summary: string | null;
  readonly fromVersionId: string | null;
  readonly toVersionId: string;
  readonly items: readonly MemoryActivityItem[];
}

interface MemoryActivityResult {
  readonly entries: readonly MemoryActivityEntry[];
  readonly nextCursor: string | null;
}

interface MemoryActivityParams {
  readonly orgId: string;
  readonly userId: string;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * Read-only daily Memory Activity timeline for the current user, assembled
 * purely from the precomputed `memory_change_summaries` /
 * `memory_change_items` tables (never touches S3).
 *
 * Summaries are scoped per (orgId, userId) and returned most-recent-day first
 * when they have deterministic change items to display.
 */
export function zeroMemoryActivity(
  params: MemoryActivityParams,
): Computed<Promise<MemoryActivityResult>> {
  return computed(async (get): Promise<MemoryActivityResult> => {
    const filters = [
      eq(memoryChangeSummaries.orgId, params.orgId),
      eq(memoryChangeSummaries.userId, params.userId),
    ];
    if (params.cursor !== undefined) {
      filters.push(lt(memoryChangeSummaries.date, params.cursor));
    }

    const summaryPage = await get(db$)
      .selectDistinct({
        id: memoryChangeSummaries.id,
        date: memoryChangeSummaries.date,
        summary: memoryChangeSummaries.summary,
        fromVersionId: memoryChangeSummaries.fromVersionId,
        toVersionId: memoryChangeSummaries.toVersionId,
      })
      .from(memoryChangeSummaries)
      .innerJoin(
        memoryChangeItems,
        eq(memoryChangeItems.summaryId, memoryChangeSummaries.id),
      )
      .where(and(...filters))
      .orderBy(desc(memoryChangeSummaries.date))
      .limit(params.limit + 1);

    const hasMore = summaryPage.length > params.limit;
    const summaries = hasMore
      ? summaryPage.slice(0, params.limit)
      : summaryPage;
    const nextCursor = hasMore
      ? (summaries[summaries.length - 1]?.date ?? null)
      : null;

    if (summaries.length === 0) {
      return { entries: [], nextCursor: null };
    }

    const summaryIds = summaries.map((summary) => {
      return summary.id;
    });

    const items = await get(db$)
      .select({
        id: memoryChangeItems.id,
        summaryId: memoryChangeItems.summaryId,
        filePath: memoryChangeItems.filePath,
        diff: memoryChangeItems.diff,
      })
      .from(memoryChangeItems)
      .where(inArray(memoryChangeItems.summaryId, summaryIds))
      // The cron batch-inserts every item of a summary in one transaction, so
      // they all share the transaction-start `now()` `created_at`; ordering by
      // it would leave intra-day order undefined across page loads. Order by
      // the stable memory file path instead.
      .orderBy(asc(memoryChangeItems.filePath));

    const itemsBySummaryId = new Map<string, MemoryActivityItem[]>();
    for (const item of items) {
      const bucket = itemsBySummaryId.get(item.summaryId) ?? [];
      bucket.push({
        filePath: item.filePath,
        diff: item.diff,
      });
      itemsBySummaryId.set(item.summaryId, bucket);
    }

    const entries: MemoryActivityEntry[] = [];
    for (const summary of summaries) {
      const summaryItems = itemsBySummaryId.get(summary.id) ?? [];
      if (summaryItems.length === 0) {
        continue;
      }
      entries.push({
        date: summary.date,
        summary: summary.summary,
        fromVersionId: summary.fromVersionId,
        toVersionId: summary.toVersionId,
        items: summaryItems,
      });
    }

    return { entries, nextCursor };
  });
}
