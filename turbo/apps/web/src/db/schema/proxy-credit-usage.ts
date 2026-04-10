import {
  bigint,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";

/**
 * Proxy-reported credit usage — token counts extracted by the mitmproxy addon
 * from LLM API streaming responses.
 *
 * Temporary table for billing verification: compare proxy-observed usage
 * against client-reported credit_usage records. Will be merged into
 * credit_usage once the two sources are validated as consistent.
 *
 * One row per LLM API call (each SSE stream or JSON response).
 */
export const proxyCreditUsage = pgTable(
  "proxy_credit_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
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
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    messageId: varchar("message_id", { length: 100 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_proxy_credit_usage_run_id").on(table.runId),
      index("idx_proxy_credit_usage_org_created").on(
        table.orgId,
        table.createdAt,
      ),
      uniqueIndex("idx_proxy_credit_usage_run_id_message_id").on(
        table.runId,
        table.messageId,
      ),
    ];
  },
);
