import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storages } from "./storage";

export const PI_MEMORY_PHASE2_JOB_STATUSES = [
  "idle",
  "pending",
  "leased",
  "retryable_failure",
  "terminal_failure",
] as const;

export type PiMemoryPhase2JobStatus =
  (typeof PI_MEMORY_PHASE2_JOB_STATUSES)[number];

export const PI_MEMORY_PHASE2_MAX_ATTEMPTS = 3;
export const PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES = 256;
export const PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES = 21_036_800;

/**
 * Serialized Phase 2 control state for one canonical user memory Storage.
 * Generated memory content remains outside this row.
 */
export const piMemoryPhase2Jobs = pgTable(
  "pi_memory_phase2_jobs",
  {
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    status: varchar("status", { length: 32 })
      .$type<PiMemoryPhase2JobStatus>()
      .default("pending")
      .notNull(),
    inputRevision: integer("input_revision").default(1).notNull(),
    completedRevision: integer("completed_revision").default(0).notNull(),
    claimedRevision: integer("claimed_revision"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryAt: timestamp("retry_at"),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    lastSucceededAt: timestamp("last_succeeded_at"),
    claimedSelectionDigest: varchar("claimed_selection_digest", {
      length: 64,
    }),
    claimedSelectedCount: integer("claimed_selected_count"),
    claimedSelectedUtf8Bytes: integer("claimed_selected_utf8_bytes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_memory_phase2_jobs_pkey",
        columns: [table.memoryStorageId],
      }),
      foreignKey({
        name: "pi_memory_phase2_jobs_storage_owner_fk",
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
      }).onDelete("cascade"),
      index("idx_pi_memory_phase2_jobs_claimable")
        .on(
          table.status,
          table.retryAt,
          table.leaseExpiresAt,
          table.lastSucceededAt,
          table.updatedAt,
          table.memoryStorageId,
        )
        .where(
          sql`${table.completedRevision} < ${table.inputRevision} AND ${table.status} IN ('pending', 'leased', 'retryable_failure')`,
        ),
      index("idx_pi_memory_phase2_jobs_user_export").on(
        table.userId,
        table.orgId,
        table.memoryStorageId,
      ),
      check(
        "pi_memory_phase2_jobs_status_check",
        sql`${table.status} IN ('idle', 'pending', 'leased', 'retryable_failure', 'terminal_failure')`,
      ),
      check(
        "pi_memory_phase2_jobs_revisions_check",
        sql`${table.inputRevision} > 0 AND
          ${table.completedRevision} >= 0 AND
          ${table.completedRevision} <= ${table.inputRevision} AND
          (
            ${table.claimedRevision} IS NULL OR (
              ${table.completedRevision} < ${table.claimedRevision} AND
              ${table.claimedRevision} <= ${table.inputRevision}
            )
          )`,
      ),
      check(
        "pi_memory_phase2_jobs_retry_count_check",
        sql`${table.retryCount} >= 0 AND ${table.retryCount} <= 3`,
      ),
      check(
        "pi_memory_phase2_jobs_error_class_check",
        sql`${table.lastErrorClass} IS NULL OR ${table.lastErrorClass} ~ '^[a-z][a-z0-9_]{0,127}$'`,
      ),
      check(
        "pi_memory_phase2_jobs_selection_check",
        sql`(
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.claimedSelectionDigest} IS NOT NULL AND
          ${table.claimedSelectedCount} IS NOT NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NOT NULL AND
          ${table.claimedSelectionDigest} ~ '^[0-9a-f]{64}$' AND
          ${table.claimedSelectedCount} >= 0 AND
          ${table.claimedSelectedCount} <= 256 AND
          ${table.claimedSelectedUtf8Bytes} >= 0 AND
          ${table.claimedSelectedUtf8Bytes} <= 21036800
        )`,
      ),
      check(
        "pi_memory_phase2_jobs_state_check",
        sql`(
          ${table.status} = 'idle' AND
          ${table.completedRevision} = ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 0 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'pending' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 0 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'leased' AND
          ${table.claimedRevision} IS NOT NULL AND
          ${table.completedRevision} < ${table.claimedRevision} AND
          ${table.claimedRevision} <= ${table.inputRevision} AND
          ${table.leaseToken} IS NOT NULL AND
          ${table.leaseExpiresAt} IS NOT NULL AND
          ${table.retryCount} >= 0 AND
          ${table.retryCount} < 3 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NOT NULL AND
          ${table.claimedSelectedCount} IS NOT NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NOT NULL
        ) OR (
          ${table.status} = 'retryable_failure' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} > 0 AND
          ${table.retryCount} < 3 AND
          ${table.retryAt} IS NOT NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'terminal_failure' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 3 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        )`,
      ),
    ];
  },
);
