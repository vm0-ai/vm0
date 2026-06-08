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
