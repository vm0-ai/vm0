import {
  customType,
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
import { sql } from "drizzle-orm";
import type {
  MemoryContextSpaceMetadata,
  MemoryDocumentChunkCitation,
  MemoryDocumentMetadata,
  MemorySourceMetadata,
  MemoryTombstoneMetadata,
  MemoryVersionMetadata,
} from "@vm0/db/jsonb-contracts/memory-substrate";
export type {
  MemoryContextSpaceMetadata,
  MemoryDocumentChunkCitation,
  MemoryDocumentMetadata,
  MemorySourceMetadata,
  MemoryTombstoneMetadata,
  MemoryVersionMetadata,
} from "@vm0/db/jsonb-contracts/memory-substrate";

export const MEMORY_PROVIDERS = ["gmail", "slack", "github", "notion"] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

export const MEMORY_SOURCE_TYPES = [
  "gmail_message",
  "slack_message",
  "github_issue",
  "github_pull_request",
  "github_issue_comment",
  "notion_page",
  "notion_page_event",
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const MEMORY_CONTEXT_SPACE_TYPES = [
  "user",
  "org",
  "project",
  "repo",
  "customer",
  "agent",
  "workflow",
] as const;
export type MemoryContextSpaceType =
  (typeof MEMORY_CONTEXT_SPACE_TYPES)[number];

export const MEMORY_DOCUMENT_STATUSES = [
  "active",
  "archived",
  "deleted",
] as const;
export type MemoryDocumentStatus = (typeof MEMORY_DOCUMENT_STATUSES)[number];

export const MEMORY_ENTITY_TYPES = [
  "person",
  "organization",
  "channel",
  "project",
] as const;
export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

export const MEMORY_ALIAS_TYPES = [
  "email",
  "domain",
  "relationship_identity",
  "slack_user",
  "slack_workspace",
  "slack_channel",
  "github_user",
  "github_repository",
  "notion_workspace",
  "notion_page",
] as const;
export type MemoryAliasType = (typeof MEMORY_ALIAS_TYPES)[number];

export const MEMORY_KINDS = [
  "key_fact",
  "preference",
  "open_loop",
  "role",
  "project",
  "communication_style",
  "recent_context",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_EDGE_TYPES = [
  "updates",
  "extends",
  "resolves",
  "derives_from",
  "contradicts",
] as const;
export type MemoryEdgeType = (typeof MEMORY_EDGE_TYPES)[number];

export const MEMORY_SEARCH_ENTRY_KINDS = ["memory_text"] as const;
export type MemorySearchEntryKind = (typeof MEMORY_SEARCH_ENTRY_KINDS)[number];

export const MEMORY_VERSION_TARGET_KINDS = [
  "memory",
  "document",
  "profile",
] as const;
export type MemoryVersionTargetKind =
  (typeof MEMORY_VERSION_TARGET_KINDS)[number];

export const MEMORY_TOMBSTONE_TARGET_KINDS = [
  "memory",
  "document",
  "document_chunk",
  "profile",
] as const;
export type MemoryTombstoneTargetKind =
  (typeof MEMORY_TOMBSTONE_TARGET_KINDS)[number];

const vector1536 = customType<{
  data: readonly number[];
  driverData: string;
}>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
});

export const memoryContextSpaces = pgTable(
  "memory_context_spaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 32 })
      .$type<MemoryContextSpaceType>()
      .notNull(),
    key: varchar("key", { length: 512 }).notNull(),
    displayName: text("display_name").notNull(),
    metadata: jsonb("metadata").$type<MemoryContextSpaceMetadata>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_context_spaces_key").on(
        table.orgId,
        table.userId,
        table.type,
        table.key,
      ),
      index("idx_memory_context_spaces_scope_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
    ];
  },
);

export const memorySources = pgTable(
  "memory_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    provider: varchar("provider", { length: 50 })
      .$type<MemoryProvider>()
      .notNull(),
    sourceType: varchar("source_type", { length: 64 })
      .$type<MemorySourceType>()
      .notNull(),
    externalId: varchar("external_id", { length: 512 }).notNull(),
    connectorId: uuid("connector_id"),
    occurredAt: timestamp("occurred_at"),
    title: text("title"),
    contentHash: varchar("content_hash", { length: 64 }),
    metadata: jsonb("metadata").$type<MemorySourceMetadata>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_sources_external").on(
        table.orgId,
        table.userId,
        table.provider,
        table.externalId,
      ),
      index("idx_memory_sources_scope_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_memory_sources_context_space").on(table.contextSpaceId),
      index("idx_memory_sources_occurred").on(
        table.orgId,
        table.userId,
        table.occurredAt.desc(),
      ),
    ];
  },
);

export const memoryDocuments = pgTable(
  "memory_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id")
      .notNull()
      .references(
        () => {
          return memoryContextSpaces.id;
        },
        { onDelete: "cascade" },
      ),
    sourceId: uuid("source_id").references(
      () => {
        return memorySources.id;
      },
      { onDelete: "set null" },
    ),
    provider: varchar("provider", { length: 50 })
      .$type<MemoryProvider>()
      .notNull(),
    sourceType: varchar("source_type", { length: 64 })
      .$type<MemorySourceType>()
      .notNull(),
    externalId: varchar("external_id", { length: 512 }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<MemoryDocumentStatus>()
      .default("active")
      .notNull(),
    title: text("title"),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at"),
    metadata: jsonb("metadata").$type<MemoryDocumentMetadata>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_documents_external").on(
        table.orgId,
        table.userId,
        table.provider,
        table.externalId,
      ),
      index("idx_memory_documents_context_status").on(
        table.contextSpaceId,
        table.status,
      ),
      index("idx_memory_documents_scope_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
    ];
  },
);

export const memoryDocumentChunks = pgTable(
  "memory_document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id")
      .notNull()
      .references(
        () => {
          return memoryContextSpaces.id;
        },
        { onDelete: "cascade" },
      ),
    documentId: uuid("document_id")
      .notNull()
      .references(
        () => {
          return memoryDocuments.id;
        },
        { onDelete: "cascade" },
      ),
    sourceId: uuid("source_id").references(
      () => {
        return memorySources.id;
      },
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 32 })
      .$type<MemoryDocumentStatus>()
      .default("active")
      .notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    tokenCount: integer("token_count").notNull(),
    citation: jsonb("citation").$type<MemoryDocumentChunkCitation>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_document_chunks_document_index").on(
        table.documentId,
        table.chunkIndex,
      ),
      index("idx_memory_document_chunks_context_status").on(
        table.contextSpaceId,
        table.status,
      ),
      index("idx_memory_document_chunks_source").on(table.sourceId),
    ];
  },
);

export const memoryDocumentSearchEntries = pgTable(
  "memory_document_search_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id")
      .notNull()
      .references(
        () => {
          return memoryContextSpaces.id;
        },
        { onDelete: "cascade" },
      ),
    documentId: uuid("document_id")
      .notNull()
      .references(
        () => {
          return memoryDocuments.id;
        },
        { onDelete: "cascade" },
      ),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(
        () => {
          return memoryDocumentChunks.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 32 })
      .$type<MemoryDocumentStatus>()
      .default("active")
      .notNull(),
    text: text("text").notNull(),
    embedding: vector1536("embedding").notNull(),
    embeddingModel: varchar("embedding_model", { length: 128 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_document_search_entries_chunk").on(
        table.chunkId,
        table.embeddingModel,
      ),
      index("idx_memory_document_search_entries_scope_status").on(
        table.orgId,
        table.userId,
        table.status,
      ),
      index("idx_memory_document_search_entries_context").on(
        table.contextSpaceId,
      ),
      index("idx_memory_document_search_entries_embedding_hnsw").using(
        "hnsw",
        sql`embedding vector_cosine_ops`,
      ),
    ];
  },
);

export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    targetKind: varchar("target_kind", { length: 32 })
      .$type<MemoryVersionTargetKind>()
      .notNull(),
    targetId: uuid("target_id").notNull(),
    version: integer("version").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<MemoryVersionMetadata>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_versions_target_version").on(
        table.targetKind,
        table.targetId,
        table.version,
      ),
      index("idx_memory_versions_scope").on(table.orgId, table.userId),
      index("idx_memory_versions_context").on(table.contextSpaceId),
    ];
  },
);

export const memoryTombstones = pgTable(
  "memory_tombstones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    targetKind: varchar("target_kind", { length: 32 })
      .$type<MemoryTombstoneTargetKind>()
      .notNull(),
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    metadata: jsonb("metadata").$type<MemoryTombstoneMetadata>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_tombstones_fingerprint").on(
        table.orgId,
        table.userId,
        table.targetKind,
        table.fingerprint,
      ),
      index("idx_memory_tombstones_context").on(table.contextSpaceId),
    ];
  },
);

export const memoryEntities = pgTable(
  "memory_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 32 }).$type<MemoryEntityType>().notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_memory_entities_scope_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
    ];
  },
);

export const memoryEntityAliases = pgTable(
  "memory_entity_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(
        () => {
          return memoryEntities.id;
        },
        { onDelete: "cascade" },
      ),
    provider: varchar("provider", { length: 50 }).$type<MemoryProvider>(),
    aliasType: varchar("alias_type", { length: 64 })
      .$type<MemoryAliasType>()
      .notNull(),
    aliasValue: varchar("alias_value", { length: 512 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_entity_aliases_alias").on(
        table.orgId,
        table.userId,
        table.aliasType,
        table.aliasValue,
      ),
      index("idx_memory_entity_aliases_entity").on(table.entityId),
    ];
  },
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    entityId: uuid("entity_id").references(
      () => {
        return memoryEntities.id;
      },
      { onDelete: "set null" },
    ),
    kind: varchar("kind", { length: 64 }).$type<MemoryKind>().notNull(),
    status: varchar("status", { length: 32 })
      .$type<MemoryStatus>()
      .default("active")
      .notNull(),
    text: text("text").notNull(),
    confidence: integer("confidence").notNull().default(80),
    sourceCount: integer("source_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_memories_scope_kind").on(
        table.orgId,
        table.userId,
        table.kind,
      ),
      index("idx_memories_context_status").on(
        table.contextSpaceId,
        table.status,
      ),
      index("idx_memories_entity_status").on(table.entityId, table.status),
    ];
  },
);

export const memorySourceLinks = pgTable(
  "memory_source_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(
        () => {
          return memories.id;
        },
        { onDelete: "cascade" },
      ),
    sourceId: uuid("source_id")
      .notNull()
      .references(
        () => {
          return memorySources.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_source_links_pair").on(
        table.memoryId,
        table.sourceId,
      ),
      index("idx_memory_source_links_source").on(table.sourceId),
    ];
  },
);

export const memoryEdges = pgTable(
  "memory_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    fromMemoryId: uuid("from_memory_id")
      .notNull()
      .references(
        () => {
          return memories.id;
        },
        { onDelete: "cascade" },
      ),
    toMemoryId: uuid("to_memory_id")
      .notNull()
      .references(
        () => {
          return memories.id;
        },
        { onDelete: "cascade" },
      ),
    edgeType: varchar("edge_type", { length: 64 })
      .$type<MemoryEdgeType>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_edges_unique").on(
        table.fromMemoryId,
        table.toMemoryId,
        table.edgeType,
      ),
      index("idx_memory_edges_to").on(table.toMemoryId),
    ];
  },
);

export const memoryProfiles = pgTable(
  "memory_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    entityId: uuid("entity_id")
      .notNull()
      .references(
        () => {
          return memoryEntities.id;
        },
        { onDelete: "cascade" },
      ),
    section: varchar("section", { length: 64 }).notNull(),
    content: text("content").notNull(),
    sourceMemoryCount: integer("source_memory_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_profiles_entity_section").on(
        table.entityId,
        table.section,
      ),
      index("idx_memory_profiles_scope").on(table.orgId, table.userId),
      index("idx_memory_profiles_context").on(table.contextSpaceId),
    ];
  },
);

export const memorySearchEntries = pgTable(
  "memory_search_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    contextSpaceId: uuid("context_space_id").references(
      () => {
        return memoryContextSpaces.id;
      },
      { onDelete: "set null" },
    ),
    memoryId: uuid("memory_id")
      .notNull()
      .references(
        () => {
          return memories.id;
        },
        { onDelete: "cascade" },
      ),
    entityId: uuid("entity_id").references(
      () => {
        return memoryEntities.id;
      },
      { onDelete: "set null" },
    ),
    entryKind: varchar("entry_kind", { length: 64 })
      .$type<MemorySearchEntryKind>()
      .notNull(),
    memoryKind: varchar("memory_kind", { length: 64 })
      .$type<MemoryKind>()
      .notNull(),
    status: varchar("status", { length: 32 })
      .$type<MemoryStatus>()
      .default("active")
      .notNull(),
    text: text("text").notNull(),
    embedding: vector1536("embedding").notNull(),
    embeddingModel: varchar("embedding_model", { length: 128 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    confidence: integer("confidence").notNull().default(80),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_memory_search_entries_memory_kind").on(
        table.memoryId,
        table.entryKind,
        table.embeddingModel,
      ),
      index("idx_memory_search_entries_scope_status_kind").on(
        table.orgId,
        table.userId,
        table.status,
        table.memoryKind,
      ),
      index("idx_memory_search_entries_context").on(table.contextSpaceId),
      index("idx_memory_search_entries_entity").on(table.entityId),
      index("idx_memory_search_entries_embedding_hnsw").using(
        "hnsw",
        sql`embedding vector_cosine_ops`,
      ),
    ];
  },
);
