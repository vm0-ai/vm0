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
 * Per-result token usage records for credits billing.
 * Each result event within a run creates its own row, keyed by (runId, resultUuid).
 * Processed later by the deduction processor to charge credits.
 */
export const creditUsage = pgTable(
  "credit_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    resultUuid: uuid("result_uuid"),
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
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_credit_usage_run_result").on(
        table.runId,
        table.resultUuid,
      ),
      index("idx_credit_usage_run_id").on(table.runId),
      index("idx_credit_usage_org_status").on(table.orgId, table.status),
      index("idx_credit_usage_org_created").on(
        table.orgId,
        table.createdAt.desc(),
      ),
      index("idx_credit_usage_org_user_status_processed").on(
        table.orgId,
        table.userId,
        table.status,
        table.processedAt,
      ),
    ];
  },
);
