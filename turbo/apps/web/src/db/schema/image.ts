import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
 */
export const images = pgTable(
  "images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    alias: varchar("alias", { length: 64 }).notNull(), // User-specified name
    e2bAlias: varchar("e2b_alias", { length: 128 }).notNull(), // E2B template name: user-{userId}-{alias}
    e2bTemplateId: varchar("e2b_template_id", { length: 64 }), // E2B template ID (set after build completes)
    e2bBuildId: varchar("e2b_build_id", { length: 64 }).notNull(), // E2B build ID for status polling
    status: varchar("status", { length: 16 }).notNull().default("building"),
    errorMessage: text("error_message"), // Error message if build failed
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userAliasIdx: uniqueIndex("idx_images_user_alias").on(
      table.userId,
      table.alias,
    ),
  }),
);
