import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * GitHub Installations table
 * Stores GitHub App installation data and default agent configuration.
 * One record per GitHub App installation (user or org level).
 */
export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  installationId: varchar("installation_id", { length: 255 })
    .notNull()
    .unique(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  defaultComposeId: uuid("default_compose_id")
    .notNull()
    .references(() => agentComposes.id, { onDelete: "restrict" }),
  repoConfigs: jsonb("repo_configs"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
