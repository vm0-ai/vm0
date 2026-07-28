import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";
import { orgUsageAllowanceWindows } from "./org-usage-allowance";

/**
 * Hourly aggregates of finalized usage events.
 *
 * Product readers regroup across the nullable allowance-window pair. The pair
 * identifies only the allowance portion of a row and remains available for
 * allowance reconciliation after raw allocations are removed.
 */
export const usageEventHourly = pgTable(
  "usage_event_hourly",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    processedHour: timestamp("processed_hour").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    kind: varchar("kind", { length: 30 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    shortWindowId: uuid("short_window_id"),
    weeklyWindowId: uuid("weekly_window_id"),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }).notNull(),
    allowanceUnits: bigint("allowance_units", { mode: "number" }).notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_usage_event_hourly_short_window",
        columns: [table.shortWindowId],
        foreignColumns: [orgUsageAllowanceWindows.id],
      }),
      foreignKey({
        name: "fk_usage_event_hourly_weekly_window",
        columns: [table.weeklyWindowId],
        foreignColumns: [orgUsageAllowanceWindows.id],
      }),
      index("idx_usage_event_hourly_org_hour").on(
        table.orgId,
        table.processedHour,
      ),
      index("idx_usage_event_hourly_processed_org_user").on(
        table.processedHour.desc(),
        table.orgId,
        table.userId,
      ),
      index("idx_usage_event_hourly_run_id").on(table.runId),
      index("idx_usage_event_hourly_user_id").on(table.userId),
      index("idx_usage_event_hourly_short_window_id").on(table.shortWindowId),
      index("idx_usage_event_hourly_weekly_window_id").on(table.weeklyWindowId),
      check(
        "chk_usage_event_hourly_processed_hour",
        sql`${table.processedHour} = date_trunc('hour', ${table.processedHour})`,
      ),
      check("chk_usage_event_hourly_quantity", sql`${table.quantity} >= 0`),
      check(
        "chk_usage_event_hourly_credits_charged",
        sql`${table.creditsCharged} >= 0`,
      ),
      check(
        "chk_usage_event_hourly_allowance_units",
        sql`${table.allowanceUnits} >= 0`,
      ),
      check(
        "chk_usage_event_hourly_allowance_window_pair",
        sql`(
          ${table.allowanceUnits} = 0
          AND ${table.shortWindowId} IS NULL
          AND ${table.weeklyWindowId} IS NULL
        ) OR (
          ${table.allowanceUnits} > 0
          AND ${table.shortWindowId} IS NOT NULL
          AND ${table.weeklyWindowId} IS NOT NULL
        )`,
      ),
    ];
  },
);
