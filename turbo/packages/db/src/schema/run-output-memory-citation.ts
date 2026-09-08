import type { RunOutputMemoryCitation } from "../jsonb-contracts/run-output-memory-citation";
import {
  primaryKey,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Private server-owned provenance for one accepted output event. Keeping this
 * outside strict chat event payloads makes the schema additive for old APIs.
 */
export const runOutputMemoryCitations = pgTable(
  "run_output_memory_citations",
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
    citation: jsonb("citation").$type<RunOutputMemoryCitation>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.runId, table.sequenceNumber] })];
  },
);
