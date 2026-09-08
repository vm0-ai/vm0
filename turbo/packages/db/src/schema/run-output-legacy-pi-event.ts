import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Private transient buffer for old Pi Guests whose citation envelope spans
 * independently acknowledged HTTP requests. Classified rows are deleted in
 * the same transaction that materializes their public projection.
 */
export const runOutputLegacyPiEvents = pgTable(
  "run_output_legacy_pi_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    sequenceNumber: integer("sequence_number").notNull(),
    serializedEvent: text("serialized_event").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.runId, table.sequenceNumber] })];
  },
);
