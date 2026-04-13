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
 * Client-reported per-result-event token usage.  Written by the events
 * webhook from Claude Code's result events.
 *
 * This is an audit trail, not a billing source.  Billing is driven by
 * the proxy-sourced `credit_usage` table, which captures every API
 * call (including subagents) observed by mitmproxy.
 *
 * Rows are deduplicated by (runId, resultUuid).  When the result event
 * lacks a uuid, multiple rows may share the same (runId, null) key
 * because PostgreSQL treats NULLs as distinct in unique indexes.
 */
export const clientCreditUsage = pgTable(
  "client_credit_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_client_credit_usage_run_result").on(
        table.runId,
        table.resultUuid,
      ),
      index("idx_client_credit_usage_run_id").on(table.runId),
      index("idx_client_credit_usage_org_created").on(
        table.orgId,
        table.createdAt.desc(),
      ),
    ];
  },
);
