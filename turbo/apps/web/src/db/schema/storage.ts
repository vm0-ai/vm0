import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Storage type:
 * - "volume": Static storage that doesn't auto-version after runs
 * - "artifact": Work products that auto-version after runs
 */
export type StorageTypeEnum = "volume" | "artifact";

/**
 * Storages table
 * Main table for user storage with HEAD pointer to current version
 */
export const storages = pgTable(
  "storages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("volume"),
    s3Prefix: text("s3_prefix").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    headVersionId: varchar("head_version_id", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userNameTypeIdx: uniqueIndex("idx_storages_user_name_type").on(
      table.userId,
      table.name,
      table.type,
    ),
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
