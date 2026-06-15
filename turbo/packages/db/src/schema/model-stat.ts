import {
  pgTable,
  uuid,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Hourly model usage rollup used by the public model rankings page.
 *
 * `hourStart` is the UTC hour bucket of usage activity time. Rows are
 * re-aggregated idempotently by the internal cron endpoint.
 */
export const modelStat = pgTable(
  "model_stat",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hourStart: timestamp("hour_start").notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    modelProvider: varchar("model_provider", { length: 100 })
      .notNull()
      .default(""),
    requestCount: bigint("request_count", { mode: "number" })
      .notNull()
      .default(0),
    orgCount: integer("org_count").notNull().default(0),
    userCount: integer("user_count").notNull().default(0),
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
    totalTokens: bigint("total_tokens", { mode: "number" })
      .notNull()
      .default(0),
    creditsCharged: bigint("credits_charged", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_model_stat_hour_model_provider").on(
        table.hourStart,
        table.model,
        table.modelProvider,
      ),
      index("idx_model_stat_hour_start").on(table.hourStart.desc()),
      index("idx_model_stat_model_hour").on(
        table.model,
        table.hourStart.desc(),
      ),
    ];
  },
);
