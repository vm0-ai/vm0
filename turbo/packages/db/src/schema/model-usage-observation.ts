import {
  bigint,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Compact model usage observations for public model statistics.
 *
 * Billing is recorded separately in `usage_event`. This table keeps only the
 * immutable delivery identity and counters consumed by model rankings.
 */
export const modelUsageObservation = pgTable(
  "model_usage_observation",
  {
    idempotencyKey: uuid("idempotency_key").primaryKey(),
    model: varchar("model", { length: 255 }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }).notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_usage_observation_observed_at").on(
        table.observedAt.desc(),
      ),
    ];
  },
);
