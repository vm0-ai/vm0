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
 * Compatibility-only declaration for the physical table retained by #26154.
 * The outgoing API, cron jobs, and Clerk cleanup can still read or write this
 * table during the observed ~102-minute DB/API rollout window. Remove with
 * #26170 once the preceding API release and rollback/drain window have closed.
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
