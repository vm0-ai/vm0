import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-session";

/**
 * iMessage Thread Sessions table
 * Maps iMessage users to agent sessions for conversation continuity.
 * One iMessage thread per user per org (single ongoing session).
 */
export const imessageThreadSessions = pgTable(
  "imessage_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(
        () => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    lastMessageId: varchar("last_message_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_imessage_thread_sessions_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
