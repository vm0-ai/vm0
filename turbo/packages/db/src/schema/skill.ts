import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { storages } from "./storage";

/**
 * Skills table
 * Global cache of GitHub-hosted skills. Each row represents one skill
 * identified by its canonical GitHub tree URL. Skills are shared across
 * all orgs — not org-scoped.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").unique().notNull(),
    name: text("name").notNull(),
    fullPath: text("full_path").notNull(),
    storageId: uuid("storage_id").references(() => {
      return storages.id;
    }),
    versionHash: varchar("version_hash", { length: 64 }),
    commitSha: varchar("commit_sha", { length: 40 }),
    frontmatter: jsonb("frontmatter"),
    s3Key: text("s3_key"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    syncedAt: timestamp("synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_skills_name").on(table.name),
      index("idx_skills_storage_id").on(table.storageId),
    ];
  },
);
