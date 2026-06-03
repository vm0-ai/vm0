import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { memoryChangeSummaries } from "./memory-change-summary";

/**
 * A single deterministic memory change item belonging to a daily summary.
 * Each item records one changed memory file with inline before/after snippets,
 * so reading the Memory Activity page is a pure DB read (no S3 diffing).
 *
 * `kind` is one of `learned` | `updated` | `forgotten`. `title` / `description`
 * are derived from frontmatter where available and may be null. Items are
 * deleted with their parent summary via the cascade FK.
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
    kind: varchar("kind", { length: 16 }).notNull(),
    title: text("title"),
    description: text("description"),
    filePath: text("file_path").notNull(),
    beforeSnippet: text("before_snippet"),
    afterSnippet: text("after_snippet"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_memory_change_items_summary").on(table.summaryId)];
  },
);
