import {
  pgTable,
  uuid,
  text,
  date,
  integer,
  bigint,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Pre-aggregated daily usage statistics per user per org.
 * Populated by /api/cron/aggregate-usage to avoid real-time aggregation
 * queries on agent_runs for historical data.
 */
export const usageDaily = pgTable(
  "usage_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    date: date("date").notNull(),
    runCount: integer("run_count").notNull().default(0),
    runTimeMs: bigint("run_time_ms", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_daily_user_org_date").on(
        table.userId,
        table.orgId,
        table.date,
      ),
    ];
  },
);
