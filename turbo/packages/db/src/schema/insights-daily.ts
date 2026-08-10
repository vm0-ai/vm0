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
import type { InsightsDailyData } from "@vm0/db/jsonb-contracts/insights-daily";

/**
 * Compatibility-only declaration for the physical table retained by #26154.
 * The outgoing API and cron jobs can still read and write this table while the
 * database is ahead of the API for the observed ~102-minute rollout window.
 * Remove with #26170 once the preceding API release and rollback/drain window
 * have closed.
 */
export const insightsDaily = pgTable(
  "insights_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    date: date("date").notNull(),
    data: jsonb("data").$type<InsightsDailyData>().notNull(),
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
