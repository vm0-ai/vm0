import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Durable control-plane state for transferring a Pi run from the API process
 * to its sandbox standby. Pi model messages remain exclusively in
 * pi_thread_messages; this row only records the committed ownership boundary.
 */
export const piRunHandoffs = pgTable("pi_run_handoffs", {
  runId: uuid("run_id")
    .primaryKey()
    .references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    ),
  transcriptVersion: integer("transcript_version").notNull(),
  afterOrdinal: integer("after_ordinal").notNull(),
  messageId: text("message_id").notNull(),
  fromEnvironment: text("from_environment").notNull(),
  toEnvironment: text("to_environment").notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
});
