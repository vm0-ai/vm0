import {
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Temporary archive of the legacy agent_run_events table.
 *
 * Runtime event reads and writes use the agent-run-events Axiom dataset. This
 * table remains only for the 30-day production archive window before it is
 * dropped.
 */
export const archivedAgentRunEvents = pgTable(
  "_archive_2026_06_14_agent_run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    eventData: jsonb("event_data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);
