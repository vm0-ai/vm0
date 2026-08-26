import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const builtInModelCandidateCooldown = pgTable(
  "built_in_model_candidate_cooldown",
  {
    selectedModel: varchar("selected_model", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    upstreamModel: varchar("upstream_model", { length: 255 }).notNull(),
    unavailableUntil: timestamp("unavailable_until").notNull(),
    connectionObservationRunId: uuid("connection_observation_run_id"),
    connectionObservationUntil: timestamp("connection_observation_until"),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.selectedModel, table.providerType, table.upstreamModel],
      }),
      check(
        "built_in_model_cooldown_observation_pair_check",
        sql`(${table.connectionObservationRunId} IS NULL AND ${table.connectionObservationUntil} IS NULL) OR (${table.connectionObservationRunId} IS NOT NULL AND ${table.connectionObservationUntil} IS NOT NULL)`,
      ),
    ];
  },
);
