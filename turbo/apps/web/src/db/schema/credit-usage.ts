import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  integer,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Per-run token usage records for credits billing.
 * Inserted by webhook when a run completes, processed later
 * by the deduction processor to charge credits.
 */
export const creditUsage = pgTable(
  "credit_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => agentRuns.id, { onDelete: "cascade" })
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    modelProvider: varchar("model_provider", { length: 100 })
      .notNull()
      .default(""),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadInputTokens: bigint("cache_read_input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }),
    numEvents: integer("num_events").notNull().default(0),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (table) => [
    uniqueIndex("uq_credit_usage_run_id").on(table.runId),
    index("idx_credit_usage_org_status").on(table.orgId, table.status),
    index("idx_credit_usage_org_created").on(
      table.orgId,
      table.createdAt.desc(),
    ),
  ],
);
