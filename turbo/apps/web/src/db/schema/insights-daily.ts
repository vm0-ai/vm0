import {
  pgTable,
  uuid,
  text,
  date,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Pre-aggregated daily insights per org.
 * Populated by /api/cron/aggregate-insights from PostgreSQL (runs, credits)
 * and Axiom (network logs, permissions) data sources.
 *
 * The `data` column stores a full DayInsight snapshot as JSONB,
 * keeping the schema flexible as new card types are added.
 */
export const insightsDaily = pgTable(
  "insights_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    date: date("date").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_insights_daily_org_date").on(table.orgId, table.date),
      index("idx_insights_daily_org_date_desc").on(
        table.orgId,
        table.date.desc(),
      ),
    ];
  },
);
