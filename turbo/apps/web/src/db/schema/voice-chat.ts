import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { agentComposes } from "./agent-compose";

/**
 * Voice-chat sessions track active voice conversations.
 * Each session has one WebRTC connection (fast-brain) and one zero agent run (slow-brain).
 *
 * Modes: chat (default) — voice starts immediately; meeting — slow-brain prepares first.
 * Statuses: preparing → active → ended | timeout
 */
export const voiceChatSessions = pgTable(
  "voice_chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    // Valid values: "chat" | "meeting"
    mode: varchar("mode", { length: 20 }).notNull().default("chat"),
    prompt: text("prompt"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => {
    return [
      index("idx_voice_chat_sessions_user").on(table.userId, table.orgId),
      index("idx_voice_chat_sessions_status").on(table.status),
    ];
  },
);

/**
 * Append-only event log for voice-chat shared context (blackboard pattern).
 * Both fast-brain (browser) and slow-brain (sandbox agent) read and append events.
 *
 * Sources: system | user | fast-brain | slow-brain
 * Types: session-start | session-end | speech | request-slow-brain | response |
 *        directive | thinking | observation | preparation-ready | meeting-prompt
 */
export const voiceChatEvents = pgTable(
  "voice_chat_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(
        () => {
          return voiceChatSessions.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    seq: serial("seq").notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    content: text("content"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_voice_chat_events_session_seq").on(table.sessionId, table.seq),
    ];
  },
);
