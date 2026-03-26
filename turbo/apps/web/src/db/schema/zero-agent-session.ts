import { pgTable, uuid, jsonb } from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-session";
import type { SummaryEntry } from "@vm0/core";

/**
 * Stored chat message for server-side persistence.
 * Kept as JSONB array on zero_agent_sessions for instant session loading.
 */
export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  runId?: string;
  summaries?: SummaryEntry[];
  createdAt: string;
}

/**
 * Zero Agent Sessions table
 * Extends agent_sessions with Zero-layer chat message data.
 * PK is the agent_sessions.id - follows the zero_runs extension pattern.
 */
export const zeroAgentSessions = pgTable("zero_agent_sessions", {
  id: uuid("id")
    .primaryKey()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  chatMessages: jsonb("chat_messages").$type<StoredChatMessage[]>().default([]),
});
