import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Immutable compacted segments of finalized usage events.
 *
 * The logical grain is processed hour, organization, user, nullable run,
 * kind, provider, and category. Multiple rows may share that grain when an
 * event becomes eligible after an earlier segment was committed.
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
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }).notNull(),
    allowanceUnits: bigint("allowance_units", { mode: "number" }).notNull(),
    sourceEventCount: bigint("source_event_count", {
      mode: "number",
    }).notNull(),
    maxProcessedAt: timestamp("max_processed_at").notNull(),
    compactedAt: timestamp("compacted_at").defaultNow().notNull(),
  },
  (table) => {
    return [
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
        "chk_usage_event_hourly_source_event_count",
        sql`${table.sourceEventCount} > 0`,
      ),
      check(
        "chk_usage_event_hourly_max_processed_at",
        sql`${table.maxProcessedAt} >= ${table.processedHour} AND ${table.maxProcessedAt} < ${table.processedHour} + interval '1 hour'`,
      ),
    ];
  },
);
