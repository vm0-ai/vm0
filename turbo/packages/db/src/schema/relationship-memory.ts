import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { RelationshipSyncJobPayload } from "@vm0/db/jsonb-contracts/relationship-memory";
export type { RelationshipSyncJobPayload } from "@vm0/db/jsonb-contracts/relationship-memory";

export const RELATIONSHIP_ENTITY_TYPES = ["person", "organization"] as const;
export type RelationshipEntityType = (typeof RELATIONSHIP_ENTITY_TYPES)[number];

export const RELATIONSHIP_STATE_STATUSES = [
  "active",
  "quiet",
  "archived",
] as const;
export type RelationshipStateStatus =
  (typeof RELATIONSHIP_STATE_STATUSES)[number];

export const RELATIONSHIP_ITEM_KINDS = [
  "key_fact",
  "preference",
  "open_loop",
] as const;
export type RelationshipItemKind = (typeof RELATIONSHIP_ITEM_KINDS)[number];

export const RELATIONSHIP_MEMORY_PROVIDERS = [
  "gmail",
  "slack",
  "github",
  "notion",
] as const;
export type RelationshipMemoryProvider =
  (typeof RELATIONSHIP_MEMORY_PROVIDERS)[number];

export const RELATIONSHIP_SYNC_JOB_KINDS = [
  "gmail_bootstrap",
  "gmail_relationship_refresh",
  "memory_source_relationship_extract",
] as const;
export type RelationshipSyncJobKind =
  (typeof RELATIONSHIP_SYNC_JOB_KINDS)[number];

export const RELATIONSHIP_SYNC_JOB_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
] as const;
export type RelationshipSyncJobStatus =
  (typeof RELATIONSHIP_SYNC_JOB_STATUSES)[number];

export const RELATIONSHIP_BACKFILL_JOB_STATUSES = [
  "pending",
  "running",
  "stopped",
  "done",
  "failed",
] as const;
export type RelationshipBackfillJobStatus =
  (typeof RELATIONSHIP_BACKFILL_JOB_STATUSES)[number];

export const RELATIONSHIP_MEMORY_BOOTSTRAP_STATUSES = [
  "idle",
  "pending",
  "running",
  "done",
  "failed",
] as const;
export type RelationshipMemoryBootstrapStatus =
  (typeof RELATIONSHIP_MEMORY_BOOTSTRAP_STATUSES)[number];

export const relationshipMemorySettings = pgTable(
  "relationship_memory_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 50 })
      .$type<RelationshipMemoryProvider>()
      .notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    bootstrapStatus: varchar("bootstrap_status", { length: 32 })
      .$type<RelationshipMemoryBootstrapStatus>()
      .default("idle")
      .notNull(),
    lastSyncAt: timestamp("last_sync_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_memory_settings_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_relationship_memory_settings_enabled").on(
        table.provider,
        table.enabled,
      ),
    ];
  },
);

export const relationshipBackfillJobs = pgTable(
  "relationship_backfill_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 50 })
      .$type<RelationshipMemoryProvider>()
      .notNull(),
    connectorId: uuid("connector_id"),
    status: varchar("status", { length: 32 })
      .$type<RelationshipBackfillJobStatus>()
      .default("pending")
      .notNull(),
    query: text("query").notNull(),
    nextPageToken: text("next_page_token"),
    estimatedTotal: integer("estimated_total"),
    scannedCount: integer("scanned_count").default(0).notNull(),
    enqueuedCount: integer("enqueued_count").default(0).notNull(),
    lockedAt: timestamp("locked_at"),
    lastRunAt: timestamp("last_run_at"),
    completedAt: timestamp("completed_at"),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_backfill_jobs_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_relationship_backfill_jobs_status").on(
        table.provider,
        table.status,
        table.updatedAt,
      ),
    ];
  },
);

export const relationshipSyncJobs = pgTable(
  "relationship_sync_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    kind: varchar("kind", { length: 64 })
      .$type<RelationshipSyncJobKind>()
      .notNull(),
    provider: varchar("provider", { length: 50 })
      .$type<RelationshipMemoryProvider>()
      .notNull(),
    status: varchar("status", { length: 32 })
      .$type<RelationshipSyncJobStatus>()
      .default("pending")
      .notNull(),
    priority: integer("priority").default(100).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 512 }).notNull(),
    payload: jsonb("payload").$type<RelationshipSyncJobPayload>().notNull(),
    runAfterAt: timestamp("run_after_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_sync_jobs_dedupe").on(table.dedupeKey),
      index("idx_relationship_sync_jobs_pending").on(
        table.status,
        table.priority,
        table.runAfterAt,
      ),
      index("idx_relationship_sync_jobs_scope_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
    ];
  },
);
