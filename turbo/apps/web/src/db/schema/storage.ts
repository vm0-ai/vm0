import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Storage type:
 * - "volume": Static storage that doesn't auto-version after runs
 * - "artifact": Work products that auto-version after runs
 */
export type StorageTypeEnum = "volume" | "artifact";

/**
 * Storages table
 * Main table for scope-level storage with HEAD pointer to current version
 */
export const storages = pgTable(
  "storages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Creator (who uploaded)
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id), // Namespace (who owns)
    name: varchar("name", { length: 256 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("volume"),
    s3Prefix: text("s3_prefix").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    headVersionId: varchar("head_version_id", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    scopeNameTypeIdx: uniqueIndex("idx_storages_scope_name_type").on(
      table.scopeId,
      table.name,
      table.type,
    ),
    scopeIdx: index("idx_storages_scope").on(table.scopeId),
  }),
);

/**
 * Storage versions table
 * Stores individual versions of each storage with content-addressable SHA-256 hash IDs
 * Version ID is computed from the content itself, enabling deduplication and verification
 */
export const storageVersions = pgTable("storage_versions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  storageId: uuid("storage_id")
    .notNull()
    .references(() => storages.id, { onDelete: "cascade" }),
  s3Key: text("s3_key").notNull(),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  message: text("message"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
