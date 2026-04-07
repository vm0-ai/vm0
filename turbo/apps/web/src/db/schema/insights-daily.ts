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
 * Pre-aggregated daily insights per user within an org.
 * Populated by /api/cron/aggregate-insights from PostgreSQL (runs, credits)
 * and Axiom (network logs, permissions) data sources.
 *
 * Agent runs, services, and permissions are per-user.
 * Credits data (creditsUsed, creditBalance, teamUsage) is org-wide.
 *
 * The `data` column stores a full DayInsight snapshot as JSONB,
 * keeping the schema flexible as new card types are added.
 */
export const insightsDaily = pgTable(
  "insights_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    date: date("date").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_insights_daily_org_user_date").on(
        table.orgId,
        table.userId,
        table.date,
      ),
      index("idx_insights_daily_org_user_date_desc").on(
        table.orgId,
        table.userId,
        table.date.desc(),
      ),
    ];
  },
);
