import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { composeJobs } from "./compose-job";

/**
 * Org-aware Slack compose requests table.
 * Tracks which compose jobs were initiated from Slack.
 * One-to-one with compose_jobs — keeps Slack context separate.
 */
export const slackOrgComposeRequests = pgTable(
  "slack_org_compose_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    composeJobId: uuid("compose_job_id")
      .notNull()
      .references(() => composeJobs.id, { onDelete: "cascade" }),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    slackUserId: varchar("slack_user_id", { length: 255 }).notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_slack_org_compose_requests_job").on(table.composeJobId),
  ],
);
