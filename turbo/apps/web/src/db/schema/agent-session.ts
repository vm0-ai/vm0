import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { conversations } from "./conversation";

/**
 * Stored chat message for server-side persistence.
 * Kept as JSONB array on agent_sessions for instant session loading.
 */
export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  runId?: string;
  createdAt: string;
}

/**
 * Agent Sessions table
 * Lightweight compose ↔ conversation association for continue operations
 * Sessions always use HEAD compose version at runtime — no snapshotting
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    agentComposeId: uuid("agent_compose_id")
      .references(() => agentComposes.id, { onDelete: "cascade" })
      .notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    artifactName: varchar("artifact_name", { length: 255 }),
    memoryName: varchar("memory_name", { length: 255 }),
    chatMessages: jsonb("chat_messages")
      .$type<StoredChatMessage[]>()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Composite index for findOrCreate pattern
    index("idx_agent_sessions_user_compose_artifact").on(
      table.userId,
      table.agentComposeId,
      table.artifactName,
    ),
  ],
);
