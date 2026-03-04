import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentComposes } from "./agent-compose";

/**
 * GitHub Installations table
 * Stores GitHub App installation data and default agent configuration.
 * One record per GitHub App installation (user or org level).
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    installationId: varchar("installation_id", { length: 255 }),
    encryptedAccessToken: text("encrypted_access_token"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    targetType: varchar("target_type", { length: 20 }),
    targetId: varchar("target_id", { length: 255 }),
    defaultComposeId: uuid("default_compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "restrict" }),
    repoConfigs: jsonb("repo_configs"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_installation_id_unique")
      .on(table.installationId)
      .where(sql`installation_id IS NOT NULL`),
  ],
);
