import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agentRuns } from "./agent-run";
import { chatThreads } from "./chat-thread";

/**
 * morning_brief_schedules — one row per (org, member) that can receive a
 * Morning Brief. A row exists once the member has a known timezone; the
 * enabled/disabled preference itself lives in org_members_metadata
 * (morning_brief_enabled). `next_run_at` is null while the schedule is
 * paused (preference off or timezone cleared).
 */
export const morningBriefSchedules = pgTable(
  "morning_brief_schedules",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Fixed chat thread that receives every Morning Brief run.
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    nextRunAt: timestamp("next_run_at"),
    // Start of the Gmail/GitHub collection window (capped at 72h lookback).
    lastSuccessAt: timestamp("last_success_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      // Partial index for the minute poller: schedules with a due run.
      index("idx_morning_brief_schedules_next_run")
        .on(table.nextRunAt)
        .where(sql`next_run_at IS NOT NULL`),
    ];
  },
);

/**
 * morning_brief_deliveries — one attempt per (org, member, local date).
 * The unique index is the idempotency guard: a delivery for a local date is
 * created exactly once regardless of concurrent cron ticks.
 *
 * Status flow: collecting → queued → running → emailed | failed | skipped.
 */
export const morningBriefDeliveries = pgTable(
  "morning_brief_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Member-local calendar date (YYYY-MM-DD) the brief covers.
    briefDate: varchar("brief_date", { length: 10 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("collecting"),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    // R2 object keys for the collected input and the agent-produced output.
    inputKey: text("input_key"),
    outputKey: text("output_key"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_morning_brief_deliveries_org_user_date").on(
        table.orgId,
        table.userId,
        table.briefDate,
      ),
      index("idx_morning_brief_deliveries_run").on(table.runId),
    ];
  },
);
