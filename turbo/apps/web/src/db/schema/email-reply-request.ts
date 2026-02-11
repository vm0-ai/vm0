import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { emailThreadSessions } from "./email-thread-session";

/**
 * Email Reply Requests table
 * Tracks which agent runs were initiated from email replies
 * Consumed by the completion webhook to send response emails
 */
export const emailReplyRequests = pgTable(
  "email_reply_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    emailThreadSessionId: uuid("email_thread_session_id")
      .notNull()
      .references(() => emailThreadSessions.id, { onDelete: "cascade" }),
    inboundEmailId: varchar("inbound_email_id", { length: 255 }).notNull(),
    inboundMessageId: varchar("inbound_message_id", { length: 512 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("idx_email_reply_requests_run").on(table.runId)],
);
