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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Storages table
 * Main table for storage with HEAD pointer to current version.
 * Unique constraint: (orgId, userId, name, type)
 * - Volumes use VOLUME_ORG_USER_ID ("__org__") as userId (org-level shared)
 * - Artifacts and Memory use real userId (per-user isolated)
 */
export const storages = pgTable(
  "storages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Real userId for artifact/memory; VOLUME_ORG_USER_ID for volumes
    name: varchar("name", { length: 256 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("volume"),
    orgId: text("org_id").notNull(),
    s3Prefix: text("s3_prefix").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    headVersionId: varchar("head_version_id", { length: 64 }).references(
      (): AnyPgColumn => {
        return storageVersions.id;
      },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgIdx: index("idx_storages_org").on(table.orgId),
      orgUserNameTypeIdx: uniqueIndex("idx_storages_org_user_name_type").on(
        table.orgId,
        table.userId,
        table.name,
        table.type,
      ),
    };
  },
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
    .references(
      () => {
        return storages.id;
      },
      { onDelete: "cascade" },
    ),
  s3Key: text("s3_key").notNull(),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  message: text("message"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
