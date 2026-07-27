import { sql } from "drizzle-orm";
import {
  bigint,
  pgView,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { usageAllowanceAllocations } from "./org-usage-allowance";
import { usageEvent } from "./usage-event";
import { usageEventHourly } from "./usage-event-hourly";

/**
 * Canonical finalized usage facts.
 *
 * Raw processed events and immutable hourly segments are projected into one
 * relation so readers observe exactly one representation across the atomic
 * compaction handoff. `activityAt` keeps each branch's indexable time (exact
 * for raw events and hour-aligned for segments); readers align range bounds
 * before comparing it. `processedHour` is always hour-aligned and must drive
 * presentation buckets so raw and compacted rows behave identically in
 * fractional-offset timezones. `maxProcessedAt` retains the exact activity
 * watermark, while `settledAt` also covers processed rows without a processed
 * timestamp.
 */
export const usageEventFinalized = pgView("usage_event_finalized", {
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  runId: uuid("run_id"),
  kind: varchar("kind", { length: 30 }).notNull(),
  provider: varchar("provider", { length: 100 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  quantity: bigint("quantity", { mode: "number" }).notNull(),
  creditsCharged: bigint("credits_charged", { mode: "number" }).notNull(),
  allowanceUnits: bigint("allowance_units", { mode: "number" }).notNull(),
  sourceEventCount: bigint("source_event_count", {
    mode: "number",
  }).notNull(),
  activityAt: timestamp("activity_at"),
  processedHour: timestamp("processed_hour"),
  maxProcessedAt: timestamp("max_processed_at"),
  settledAt: timestamp("settled_at").notNull(),
}).as(sql`
  SELECT
    ${usageEvent.orgId} AS org_id,
    ${usageEvent.userId} AS user_id,
    ${usageEvent.runId} AS run_id,
    ${usageEvent.kind} AS kind,
    ${usageEvent.provider} AS provider,
    ${usageEvent.category} AS category,
    ${usageEvent.quantity} AS quantity,
    COALESCE(${usageEvent.creditsCharged}, 0)::bigint AS credits_charged,
    COALESCE(${usageAllowanceAllocations.unitsApplied}, 0)::bigint AS allowance_units,
    1::bigint AS source_event_count,
    ${usageEvent.processedAt} AS activity_at,
    date_trunc('hour', ${usageEvent.processedAt}) AS processed_hour,
    ${usageEvent.processedAt} AS max_processed_at,
    COALESCE(${usageEvent.processedAt}, ${usageEvent.createdAt}) AS settled_at
  FROM ${usageEvent}
  LEFT JOIN ${usageAllowanceAllocations}
    ON ${usageAllowanceAllocations.usageEventId} = ${usageEvent.id}
  WHERE ${usageEvent.status} = 'processed'

  UNION ALL

  SELECT
    ${usageEventHourly.orgId} AS org_id,
    ${usageEventHourly.userId} AS user_id,
    ${usageEventHourly.runId} AS run_id,
    ${usageEventHourly.kind} AS kind,
    ${usageEventHourly.provider} AS provider,
    ${usageEventHourly.category} AS category,
    ${usageEventHourly.quantity} AS quantity,
    ${usageEventHourly.creditsCharged} AS credits_charged,
    ${usageEventHourly.allowanceUnits} AS allowance_units,
    ${usageEventHourly.sourceEventCount} AS source_event_count,
    ${usageEventHourly.processedHour} AS activity_at,
    ${usageEventHourly.processedHour} AS processed_hour,
    ${usageEventHourly.maxProcessedAt} AS max_processed_at,
    ${usageEventHourly.maxProcessedAt} AS settled_at
  FROM ${usageEventHourly}
`);
