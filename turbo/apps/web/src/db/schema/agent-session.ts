import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { conversations } from "./conversation";

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
