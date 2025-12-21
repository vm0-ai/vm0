import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Image build status:
 * - "building": Build in progress
 * - "ready": Build completed successfully
 * - "error": Build failed
 */
export type ImageStatusEnum = "building" | "ready" | "error";

/**
 * Images table
 * Stores user-built E2B templates (custom Docker images)
 * Supports multiple versions per image alias (via version_id)
 */
export const images = pgTable(
  "images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    scopeId: uuid("scope_id").references(() => scopes.id), // Scope FK (nullable for migration)
    alias: varchar("alias", { length: 64 }).notNull(), // User-specified name
    versionId: varchar("version_id", { length: 64 }), // SHA256 hex (64 chars), null for legacy images
    e2bAlias: varchar("e2b_alias", { length: 256 }).notNull(), // E2B template name: scope-{scopeId}-image-{name}-version-{versionId}
    e2bTemplateId: varchar("e2b_template_id", { length: 64 }), // E2B template ID (set after build completes)
    e2bBuildId: varchar("e2b_build_id", { length: 64 }).notNull(), // E2B build ID for status polling
    status: varchar("status", { length: 16 }).notNull().default("building"),
    errorMessage: text("error_message"), // Error message if build failed
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    // Note: Unique indexes for versioning are created via SQL migration (0041)
    // - idx_images_scope_alias_version: unique on (scope_id, alias, version_id) WHERE version_id IS NOT NULL
    // - idx_images_scope_alias_legacy: unique on (scope_id, alias) WHERE version_id IS NULL
    scopeIdx: index("idx_images_scope").on(table.scopeId),
    latestLookupIdx: index("idx_images_latest_lookup").on(
      table.scopeId,
      table.alias,
      table.status,
      table.createdAt,
    ),
  }),
);
