import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Agent Run Callbacks table
 * Stores webhook callbacks to be invoked when an agent run completes.
 * Used for event-driven notifications (e.g., Slack replies) instead of polling.
 */
export const agentRunCallbacks = pgTable(
  "agent_run_callbacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Secret encrypted with AES-256-GCM for HMAC signature verification
    encryptedSecret: text("encrypted_secret").notNull(),
    // Arbitrary JSON payload to include in callback (e.g., Slack context)
    payload: jsonb("payload"),
    // pending | delivered | failed
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_run_callbacks_run_id").on(table.runId),
    index("idx_agent_run_callbacks_pending")
      .on(table.status)
      .where("status = 'pending'" as never),
  ],
);
