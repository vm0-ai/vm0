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
 * Proxy-reported per-API-call token usage for credits billing.
 * Each API call observed by mitmproxy creates its own row, keyed by
 * (runId, messageId). Processed later by the deduction processor to
 * charge credits.
 *
 * Historical rows written by the events webhook prior to the billing
 * source migration have `result_uuid` / `cost_usd` populated and
 * `message_id` null. Post-migration proxy rows have `message_id`
 * populated and `result_uuid` / `cost_usd` null. Both shapes are
 * valid and aggregated identically by downstream consumers.
 */
export const creditUsage = pgTable(
  "credit_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    resultUuid: uuid("result_uuid"),
    messageId: varchar("message_id", { length: 100 }),
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
      uniqueIndex("uq_credit_usage_run_message").on(
        table.runId,
        table.messageId,
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
