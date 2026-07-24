import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Raw model usage observations for model statistics.
 *
 * This table is intentionally separate from `usage_event`, which is the
 * billing ledger. Built-in model usage can write both tables; BYOK model usage
 * writes observations only. The model stats aggregation cron prunes observations
 * older than the maximum stats reprocessing window.
 */
export const modelUsageObservation = pgTable(
  "model_usage_observation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    idempotencyKey: uuid("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    modelProviderType: varchar("model_provider_type", { length: 100 })
      .notNull()
      .default(""),
    category: varchar("category", { length: 100 }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_model_usage_observation_idempotency_key").on(
        table.idempotencyKey,
      ),
      index("idx_model_usage_observation_run_id").on(table.runId),
      index("idx_model_usage_observation_observed_at").on(
        table.observedAt.desc(),
      ),
      index("idx_model_usage_observation_model_observed_at").on(
        table.model,
        table.observedAt.desc(),
      ),
      index("idx_model_usage_observation_org_observed_at").on(
        table.orgId,
        table.observedAt.desc(),
      ),
    ];
  },
);

/**
 * Compact model usage observations for model statistics.
 *
 * The compact idempotency key is both the row identity and the durable retry
 * boundary. Run and ownership dimensions remain request-only because public
 * rankings consume only the four token counters.
 */
export const compactModelUsageObservation = pgTable(
  "compact_model_usage_observation",
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
      index("idx_compact_model_usage_observation_observed_at").on(
        table.observedAt.desc(),
      ),
    ];
  },
);

/**
 * Temporary cross-format identity ledger for the compact observation rollout.
 *
 * Legacy inserts and compact ingestion claim the same category key here. The
 * ledger covers the bounded old-runner drain and retry horizon independently
 * of raw observation retention, then is removed after the compact rollout.
 */
export const modelUsageObservationLegacyKey = pgTable(
  "model_usage_observation_legacy_key",
  {
    idempotencyKey: uuid("idempotency_key").primaryKey(),
    observedAt: timestamp("observed_at").notNull(),
  },
  (table) => {
    return [
      index("idx_model_usage_observation_legacy_key_observed_at").on(
        table.observedAt.desc(),
      ),
    ];
  },
);
