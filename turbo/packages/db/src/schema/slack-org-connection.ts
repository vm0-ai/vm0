import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { slackOrgInstallations } from "./slack-org-installation";

/**
 * Org-aware Slack connections table.
 * Maps a Slack user to a VM0 user within a specific workspace.
 * Each Slack user can only be connected once per workspace.
 * orgId is derived from slackOrgInstallations via slackWorkspaceId.
 */
export const slackOrgConnections = pgTable(
  "slack_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackUserId: varchar("slack_user_id", { length: 255 }).notNull(),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 })
      .notNull()
      .references(() => {
        return slackOrgInstallations.slackWorkspaceId;
      }),
    vm0UserId: text("vm0_user_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_slack_org_connections_user_workspace").on(
        table.slackUserId,
        table.slackWorkspaceId,
      ),
      index("idx_slack_org_connections_workspace").on(table.slackWorkspaceId),
      index("idx_slack_org_connections_vm0_user_workspace").on(
        table.vm0UserId,
        table.slackWorkspaceId,
      ),
    ];
  },
);
