import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Write-only table projections for the Storage schema contraction.
 *
 * Production migrations run before the new API is promoted. These projections
 * intentionally omit the legacy `storages.type` and
 * `storage_version_lineage.storage_type` columns so the currently deployed API
 * remains compatible while the follow-up migration removes those columns.
 */
export const storageDml = pgTable("storages", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  orgId: text("org_id").notNull(),
  s3Prefix: text("s3_prefix").notNull(),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  headVersionId: varchar("head_version_id", { length: 64 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const storageVersionLineageDml = pgTable("storage_version_lineage", {
  storageId: uuid("storage_id").notNull(),
  versionId: varchar("version_id", { length: 64 }).notNull(),
  parentVersionId: varchar("parent_version_id", { length: 64 }).notNull(),
  runId: uuid("run_id").notNull(),
});
