import {
  pgTable,
  uuid,
  text,
  date,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-user-per-local-day net summary of memory changes within an org.
 * Populated by the daily memory-activity cron, which collapses all of a
 * user's local-day version transitions into a single before/after net diff
 * (fromVersionId -> toVersionId) and an optional LLM narrative.
 *
 * One row per (orgId, userId, date); quiet days produce no row. The first-ever
 * summary for a user has no prior version, so `fromVersionId` is nullable.
 * `summary` holds the LLM narrative and is null when LLM generation failed
 * (the deterministic change items are still persisted in memory_change_items).
 */
export const memoryChangeSummaries = pgTable(
  "memory_change_summaries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    date: date("date").notNull(),
    fromVersionId: varchar("from_version_id", { length: 64 }),
    toVersionId: varchar("to_version_id", { length: 64 }).notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_memory_change_summaries_org_user_date").on(
        table.orgId,
        table.userId,
        table.date,
      ),
      index("idx_memory_change_summaries_org_user_date_desc").on(
        table.orgId,
        table.userId,
        table.date.desc(),
      ),
    ];
  },
);
