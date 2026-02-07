import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { composeJobs } from "./compose-job";

/**
 * Slack Compose Requests table
 * Tracks which compose jobs were initiated from Slack
 * Keeps Slack context separate from the compose_jobs domain
 */
export const slackComposeRequests = pgTable(
  "slack_compose_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    composeJobId: uuid("compose_job_id")
      .notNull()
      .references(() => composeJobs.id, { onDelete: "cascade" }),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    slackUserId: varchar("slack_user_id", { length: 255 }).notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_slack_compose_requests_job").on(table.composeJobId),
  ],
);
