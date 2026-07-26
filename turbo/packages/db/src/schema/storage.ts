import { sql } from "drizzle-orm";
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
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Storages table
 * Main table for storage with HEAD pointer to current version.
 * Canonical identity: (orgId, userId, name)
 * - Org-owned storages use VOLUME_ORG_USER_ID ("__org__") as userId
 * - User-owned storages use the real userId
 * - type is a temporary legacy projection and is not part of identity
 */
export const storages = pgTable(
  "storages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Real userId for artifact/memory; VOLUME_ORG_USER_ID for volumes
    name: varchar("name", { length: 256 }).notNull(),
    // Nullable during the Storage identity contraction. New writers leave this
    // unset; the column is removed after rollback-eligible API versions drain.
    type: varchar("type", { length: 16 }),
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
      orgUserNameIdx: uniqueIndex("idx_storages_org_user_name").on(
        table.orgId,
        table.userId,
        table.name,
      ),
      // Keep the legacy identity index during the expand/contract rollout so
      // older API instances can still use their four-column ON CONFLICT target.
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
export const storageVersions = pgTable(
  "storage_versions",
  {
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
    archiveSize: bigint("archive_size", { mode: "number" }).notNull(),
    fileCount: integer("file_count").notNull().default(0),
    message: text("message"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chk_storage_versions_archive_size_nonnegative",
        sql`${table.archiveSize} >= 0`,
      ),
    ];
  },
);
