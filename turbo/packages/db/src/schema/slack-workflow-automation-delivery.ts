import type { ChatSlackMessageFiles } from "@vm0/db/jsonb-contracts/chat-slack-context";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { zeroWorkflowAutomations } from "./zero-workflow";

export type SlackWorkflowAutomationDeliveryStatus =
  | "pending"
  | "processing"
  | "processed"
  | "skipped"
  | "failed";

export type SlackWorkflowAutomationDeliverySubtype =
  | "file_share"
  | "thread_broadcast";

/**
 * Normalized, provider-owned Slack delivery state. The verified callback and
 * rich blocks never cross this persistence boundary.
 */
export const slackWorkflowAutomationDeliveries = pgTable(
  "slack_workflow_automation_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 255 }).notNull(),
    channelId: varchar("channel_id", { length: 255 }).notNull(),
    messageTs: varchar("message_ts", { length: 32 }).notNull(),
    threadTs: varchar("thread_ts", { length: 32 }),
    senderSlackUserId: varchar("sender_slack_user_id", {
      length: 255,
    }).notNull(),
    ownerSlackUserId: varchar("owner_slack_user_id", {
      length: 255,
    }).notNull(),
    subtype: varchar("subtype", {
      length: 32,
    }).$type<SlackWorkflowAutomationDeliverySubtype>(),
    normalizedText: text("normalized_text").notNull(),
    sharedChannel: boolean("shared_channel").default(false).notNull(),
    files: jsonb("files").$type<ChatSlackMessageFiles>().default([]).notNull(),
    status: varchar("status", { length: 16 })
      .$type<SlackWorkflowAutomationDeliveryStatus>()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_slack_workflow_delivery_message_unique").on(
        table.automationId,
        table.workspaceId,
        table.channelId,
        table.messageTs,
      ),
      uniqueIndex("idx_slack_workflow_delivery_event_unique").on(
        table.automationId,
        table.eventId,
      ),
      index("idx_slack_workflow_delivery_retry").on(
        table.status,
        table.updatedAt,
      ),
      check(
        "chk_slack_workflow_delivery_status",
        sql`${table.status} IN ('pending', 'processing', 'processed', 'skipped', 'failed')`,
      ),
      check(
        "chk_slack_workflow_delivery_attempts",
        sql`${table.attempts} >= 0`,
      ),
    ];
  },
);
