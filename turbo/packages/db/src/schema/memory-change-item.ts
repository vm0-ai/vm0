import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { memoryChangeSummaries } from "./memory-change-summary";
import type { MemoryChangeDiff } from "@vm0/db/jsonb-contracts/memory-change-item";
export type {
  MemoryChangeDiff,
  MemoryChangeDiffHunk,
  MemoryChangeDiffLine,
  MemoryChangeDiffLineOp,
  MemoryChangeDiffStats,
} from "@vm0/db/jsonb-contracts/memory-change-item";

/**
 * A single deterministic memory change item belonging to a daily summary.
 * Each item records one changed memory file with a precomputed structured diff,
 * so reading the Memory Activity page is a pure DB read (no S3 diffing).
 *
 * File lifecycle is stored in `diff.beforeExists` / `diff.afterExists`, so the
 * UI can derive added / deleted / modified without persisting a separate
 * presentation-oriented classification. Items are deleted with their parent
 * summary via the cascade FK.
 */
export const memoryChangeItems = pgTable(
  "memory_change_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    summaryId: uuid("summary_id")
      .notNull()
      .references(
        () => {
          return memoryChangeSummaries.id;
        },
        { onDelete: "cascade" },
      ),
    filePath: text("file_path").notNull(),
    diff: jsonb("diff").$type<MemoryChangeDiff>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_memory_change_items_summary").on(table.summaryId)];
  },
);
