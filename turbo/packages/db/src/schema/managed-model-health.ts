import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { builtInModelKeys } from "./built-in-model-key";

function healthColumns() {
  return {
    modelKeyId: uuid("model_key_id")
      .notNull()
      .references(
        () => {
          return builtInModelKeys.id;
        },
        { onDelete: "cascade" },
      ),
    modelKeyRevision: integer("model_key_revision").notNull(),
    state: varchar("state", { length: 10 }).notNull(),
    generation: integer("generation").notNull(),
    cooldownUntil: timestamp("cooldown_until"),
    probeLeaseId: uuid("probe_lease_id"),
    probeLeaseExpiresAt: timestamp("probe_lease_expires_at"),
    lastFailureKind: varchar("last_failure_kind", { length: 50 }),
    lastFailureAt: timestamp("last_failure_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}

function healthChecks(table: {
  readonly modelKeyRevision: AnyPgColumn;
  readonly state: AnyPgColumn;
  readonly generation: AnyPgColumn;
  readonly cooldownUntil: AnyPgColumn;
  readonly probeLeaseId: AnyPgColumn;
  readonly probeLeaseExpiresAt: AnyPgColumn;
  readonly lastFailureKind: AnyPgColumn;
  readonly lastFailureAt: AnyPgColumn;
}): ReturnType<typeof check>[] {
  return [
    check(
      "managed_model_health_revision_check",
      sql`${table.modelKeyRevision} > 0`,
    ),
    check(
      "managed_model_health_state_check",
      sql`${table.state} IN ('closed', 'open')`,
    ),
    check(
      "managed_model_health_generation_check",
      sql`${table.generation} > 0`,
    ),
    check(
      "managed_model_health_cooldown_check",
      sql`(
        (${table.state} = 'closed' AND ${table.cooldownUntil} IS NULL) OR
        (${table.state} = 'open' AND ${table.cooldownUntil} IS NOT NULL)
      )`,
    ),
    check(
      "managed_model_health_lease_check",
      sql`(
        (${table.probeLeaseId} IS NULL AND ${table.probeLeaseExpiresAt} IS NULL) OR
        (
          ${table.state} = 'open' AND
          ${table.probeLeaseId} IS NOT NULL AND
          ${table.probeLeaseExpiresAt} IS NOT NULL
        )
      )`,
    ),
    check(
      "managed_model_health_failure_check",
      sql`(
        (${table.lastFailureKind} IS NULL AND ${table.lastFailureAt} IS NULL) OR
        (${table.lastFailureKind} IS NOT NULL AND ${table.lastFailureAt} IS NOT NULL)
      )`,
    ),
  ];
}

export const managedModelCredentialHealth = pgTable(
  "managed_model_credential_health",
  healthColumns(),
  (table) => {
    return [
      primaryKey({ columns: [table.modelKeyId, table.modelKeyRevision] }),
      index("idx_managed_model_credential_health_cooldown").on(
        table.state,
        table.cooldownUntil,
      ),
      ...healthChecks(table),
    ];
  },
);

export const managedModelCandidateHealth = pgTable(
  "managed_model_candidate_health",
  {
    selectedModel: varchar("selected_model", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    upstreamModel: varchar("upstream_model", { length: 255 }).notNull(),
    ...healthColumns(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [
          table.selectedModel,
          table.providerType,
          table.upstreamModel,
          table.modelKeyId,
          table.modelKeyRevision,
        ],
      }),
      index("idx_managed_model_candidate_health_cooldown").on(
        table.state,
        table.cooldownUntil,
      ),
      ...healthChecks(table),
    ];
  },
);
