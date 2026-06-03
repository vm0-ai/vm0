import { computed, type Computed } from "ccstate";
import { memoryChangeItems } from "@vm0/db/schema/memory-change-item";
import { memoryChangeSummaries } from "@vm0/db/schema/memory-change-summary";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";

type MemoryActivityKind = "learned" | "updated" | "forgotten";

interface MemoryActivityItem {
  readonly kind: MemoryActivityKind;
  readonly title: string | null;
  readonly description: string | null;
  readonly filePath: string;
  readonly beforeSnippet: string | null;
  readonly afterSnippet: string | null;
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
}

function toKind(kind: string): MemoryActivityKind {
  if (kind === "learned" || kind === "updated" || kind === "forgotten") {
    return kind;
  }
  // The cron owns this vocabulary; an unknown value is a producer-side data bug
  // that should surface rather than be silently coerced.
  throw new Error(`Unexpected memory change item kind: ${kind}`);
}

/**
 * Read-only daily Memory Activity timeline for the current user, assembled
 * purely from the precomputed `memory_change_summaries` /
 * `memory_change_items` tables (never touches S3).
 *
 * Summaries are scoped per (orgId, userId) and returned most-recent-day first;
 * each summary's deterministic change items are nested under it.
 */
export function zeroMemoryActivity(
  orgId: string,
  userId: string,
): Computed<Promise<MemoryActivityResult>> {
  return computed(async (get): Promise<MemoryActivityResult> => {
    const summaries = await get(db$)
      .select({
        id: memoryChangeSummaries.id,
        date: memoryChangeSummaries.date,
        summary: memoryChangeSummaries.summary,
        fromVersionId: memoryChangeSummaries.fromVersionId,
        toVersionId: memoryChangeSummaries.toVersionId,
      })
      .from(memoryChangeSummaries)
      .where(
        and(
          eq(memoryChangeSummaries.orgId, orgId),
          eq(memoryChangeSummaries.userId, userId),
        ),
      )
      .orderBy(desc(memoryChangeSummaries.date));

    if (summaries.length === 0) {
      return { entries: [] };
    }

    const summaryIds = summaries.map((summary) => {
      return summary.id;
    });

    const items = await get(db$)
      .select({
        id: memoryChangeItems.id,
        summaryId: memoryChangeItems.summaryId,
        kind: memoryChangeItems.kind,
        title: memoryChangeItems.title,
        description: memoryChangeItems.description,
        filePath: memoryChangeItems.filePath,
        beforeSnippet: memoryChangeItems.beforeSnippet,
        afterSnippet: memoryChangeItems.afterSnippet,
      })
      .from(memoryChangeItems)
      .where(inArray(memoryChangeItems.summaryId, summaryIds))
      // The cron batch-inserts every item of a summary in one transaction, so
      // they all share the transaction-start `now()` `created_at`; ordering by
      // it would leave intra-day order undefined across page loads. Order by
      // `kind` then `file_path` instead: both are stable, non-null columns, so
      // the result is fully deterministic and matches the kind-grouped UI.
      .orderBy(asc(memoryChangeItems.kind), asc(memoryChangeItems.filePath));

    const itemsBySummaryId = new Map<string, MemoryActivityItem[]>();
    for (const item of items) {
      const bucket = itemsBySummaryId.get(item.summaryId) ?? [];
      bucket.push({
        kind: toKind(item.kind),
        title: item.title,
        description: item.description,
        filePath: item.filePath,
        beforeSnippet: item.beforeSnippet,
        afterSnippet: item.afterSnippet,
      });
      itemsBySummaryId.set(item.summaryId, bucket);
    }

    const entries = summaries.map((summary): MemoryActivityEntry => {
      return {
        date: summary.date,
        summary: summary.summary,
        fromVersionId: summary.fromVersionId,
        toVersionId: summary.toVersionId,
        items: itemsBySummaryId.get(summary.id) ?? [],
      };
    });

    return { entries };
  });
}
