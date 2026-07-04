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

export const RELATIONSHIP_MEMORY_PROVIDERS = ["gmail"] as const;
export type RelationshipMemoryProvider =
  (typeof RELATIONSHIP_MEMORY_PROVIDERS)[number];

export const RELATIONSHIP_SYNC_JOB_KINDS = [
  "gmail_bootstrap",
  "gmail_relationship_refresh",
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

export interface RelationshipSyncJobPayload {
  readonly connectorId?: string;
  readonly relationshipStateId?: string;
  readonly gmailThreadId?: string;
  readonly gmailMessageIds?: readonly string[];
  readonly gmailMessage?: {
    readonly mailboxEmail: string;
    readonly historyId: string;
    readonly messageId: string;
    readonly threadId: string | null;
    readonly from: string | null;
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly subject: string | null;
  };
  readonly historyId?: string;
  readonly reason?: string;
}

export interface RelationshipInteractionMetadata {
  readonly direction?: "sent" | "received" | "mixed" | "unknown";
  readonly participants?: readonly string[];
  readonly labels?: readonly string[];
}

export const relationshipEntities = pgTable(
  "relationship_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 32 })
      .$type<RelationshipEntityType>()
      .notNull(),
    // Deterministic per-user identity key, e.g. person email or org domain.
    identityKey: varchar("identity_key", { length: 512 }).notNull(),
    displayName: text("display_name").notNull(),
    primaryEmail: varchar("primary_email", { length: 320 }),
    domain: varchar("domain", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_entities_identity").on(
        table.orgId,
        table.userId,
        table.identityKey,
      ),
      index("idx_relationship_entities_scope_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
      index("idx_relationship_entities_email").on(
        table.orgId,
        table.userId,
        table.primaryEmail,
      ),
      index("idx_relationship_entities_domain").on(
        table.orgId,
        table.userId,
        table.domain,
      ),
    ];
  },
);

export const relationshipStates = pgTable(
  "relationship_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(
        () => {
          return relationshipEntities.id;
        },
        { onDelete: "cascade" },
      ),
    relationshipType: varchar("relationship_type", { length: 80 }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<RelationshipStateStatus>()
      .default("active")
      .notNull(),
    summary: text("summary").notNull().default(""),
    lastInteractionAt: timestamp("last_interaction_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_states_entity").on(
        table.orgId,
        table.userId,
        table.entityId,
      ),
      index("idx_relationship_states_scope_status").on(
        table.orgId,
        table.userId,
        table.status,
      ),
      index("idx_relationship_states_last_interaction").on(
        table.orgId,
        table.userId,
        table.lastInteractionAt.desc(),
      ),
    ];
  },
);

export const relationshipItems = pgTable(
  "relationship_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    relationshipStateId: uuid("relationship_state_id")
      .notNull()
      .references(
        () => {
          return relationshipStates.id;
        },
        { onDelete: "cascade" },
      ),
    kind: varchar("kind", { length: 32 })
      .$type<RelationshipItemKind>()
      .notNull(),
    text: text("text").notNull(),
    confidence: integer("confidence").notNull().default(80),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => {
    return [
      index("idx_relationship_items_state_kind").on(
        table.relationshipStateId,
        table.kind,
      ),
      index("idx_relationship_items_scope_kind").on(
        table.orgId,
        table.userId,
        table.kind,
      ),
    ];
  },
);

export const relationshipItemSources = pgTable(
  "relationship_item_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    relationshipItemId: uuid("relationship_item_id")
      .notNull()
      .references(
        () => {
          return relationshipItems.id;
        },
        { onDelete: "cascade" },
      ),
    provider: varchar("provider", { length: 50 })
      .$type<RelationshipMemoryProvider>()
      .notNull(),
    // Stored without an FK so disconnecting a connector does not delete memory.
    connectorId: uuid("connector_id"),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 255 }),
    messageId: varchar("message_id", { length: 255 }),
    quote: text("quote"),
    occurredAt: timestamp("occurred_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_item_sources_external").on(
        table.relationshipItemId,
        table.provider,
        table.externalId,
      ),
      index("idx_relationship_item_sources_scope_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
    ];
  },
);

export const relationshipInteractions = pgTable(
  "relationship_interactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    relationshipStateId: uuid("relationship_state_id")
      .notNull()
      .references(
        () => {
          return relationshipStates.id;
        },
        { onDelete: "cascade" },
      ),
    entityId: uuid("entity_id")
      .notNull()
      .references(
        () => {
          return relationshipEntities.id;
        },
        { onDelete: "cascade" },
      ),
    provider: varchar("provider", { length: 50 })
      .$type<RelationshipMemoryProvider>()
      .notNull(),
    connectorId: uuid("connector_id"),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 255 }),
    messageId: varchar("message_id", { length: 255 }),
    subject: text("subject"),
    snippet: text("snippet").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    metadata: jsonb("metadata").$type<RelationshipInteractionMetadata>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_relationship_interactions_external").on(
        table.relationshipStateId,
        table.provider,
        table.externalId,
      ),
      index("idx_relationship_interactions_state_occurred").on(
        table.relationshipStateId,
        table.occurredAt.desc(),
      ),
    ];
  },
);

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
