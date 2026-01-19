import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { conversations } from "./conversation";

/**
 * Agent Sessions table
 * VM0's concept of a persistent running context across multiple runs
 * Unlike checkpoints (immutable snapshots), sessions track the latest state
 *
 * Key fields for execution context:
 * - agentComposeVersionId: Immutable compose version (SHA-256) fixed at session creation
 * - volumeVersions: Volume versions snapshot at session creation
 * - vars: Template variables for compose expansion
 * - secretNames: Secret names for validation (values never stored)
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    agentComposeId: uuid("agent_compose_id")
      .references(() => agentComposes.id, { onDelete: "cascade" })
      .notNull(),
    // Immutable compose version ID (SHA-256 hash) fixed at session creation
    // If null (legacy sessions), resolveSession falls back to HEAD version
    agentComposeVersionId: varchar("agent_compose_version_id", { length: 255 }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    artifactName: varchar("artifact_name", { length: 255 }),
    vars: jsonb("vars").$type<Record<string, string>>(),
    // Secret names for validation (values never stored - must be provided at runtime)
    secretNames: jsonb("secret_names").$type<string[]>(),
    // Volume versions snapshot at session creation for reproducibility
    volumeVersions: jsonb("volume_versions").$type<Record<string, string>>(),
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
