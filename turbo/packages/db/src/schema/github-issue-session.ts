import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { githubInstallations } from "./github-installation";
import { agentSessions } from "./agent-session";

/**
 * GitHub Issue Sessions table
 * Maps GitHub issues to VM0 agent sessions for conversation continuity.
 * Allows agents to maintain context across multiple comments on an issue.
 */
export const githubIssueSessions = pgTable(
  "github_issue_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return githubInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    repo: varchar("repo", { length: 255 }).notNull(),
    issueNumber: integer("issue_number").notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(
        () => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    lastCommentId: varchar("last_comment_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_github_issue_sessions_installation_repo_issue").on(
        table.installationId,
        table.repo,
        table.issueNumber,
      ),
      index("idx_github_issue_sessions_installation").on(table.installationId),
    ];
  },
);
