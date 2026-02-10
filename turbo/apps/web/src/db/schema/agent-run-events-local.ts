import {
  pgTable,
  uuid,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Local storage for agent run events.
 * Used as a DB fallback when Axiom is not configured (self-hosted).
 */
export const agentRunEventsLocal = pgTable(
  "agent_run_events_local",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => agentRuns.id, { onDelete: "cascade" })
      .notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_run_events_local_run_id").on(table.runId),
    index("idx_agent_run_events_local_run_seq").on(
      table.runId,
      table.sequenceNumber,
    ),
  ],
);
