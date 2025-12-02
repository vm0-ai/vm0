import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentComposeVersions } from "./agent-compose";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 * References immutable compose version for reproducibility
 */
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(), // Clerk user ID - owner of this run
  agentComposeVersionId: varchar("agent_compose_version_id", { length: 64 })
    .references(() => agentComposeVersions.id)
    .notNull(),
  resumedFromCheckpointId: uuid("resumed_from_checkpoint_id"),
  status: varchar("status", { length: 20 }).notNull(),
  prompt: text("prompt").notNull(),
  templateVars: jsonb("template_vars"),
  sandboxId: varchar("sandbox_id", { length: 255 }),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});
