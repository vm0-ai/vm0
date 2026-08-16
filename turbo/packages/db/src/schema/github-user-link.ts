import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { githubInstallations } from "./github-installation";

/**
 * GitHub User Links table
 * Maps GitHub users to internal users for account linking.
 * Allows multiple internal users to link to the same GitHub org installation.
 */
export const githubUserLinks = pgTable(
  "github_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    githubUserId: varchar("github_user_id", { length: 255 }).notNull(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return githubInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    userId: text("user_id").notNull(),
    // DB/API rollout fallback (observed maximum exposure: ~102 minutes).
    // Remove in #27602 after the switched API is healthy, the previous API
    // version has drained, and every transition invariant remains valid.
    legacyUserId: text("vm0_user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Each GitHub user can only link to one internal user per installation
      uniqueIndex("idx_github_user_links_user_installation").on(
        table.githubUserId,
        table.installationId,
      ),
    ];
  },
);
