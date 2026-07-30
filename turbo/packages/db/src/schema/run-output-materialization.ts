import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Canonical per-run output projection consumed by terminal callbacks.
 *
 * The physical table keeps its original name so this expansion remains
 * compatible with API versions that still write the chat-only projection.
 */
export const runOutputMaterializations = pgTable(
  "chat_output_materializations",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    processedThroughSequence: integer("processed_through_sequence")
      .default(-1)
      .notNull(),
    latestResultSequence: integer("latest_result_sequence"),
    latestResultText: text("latest_result_text"),
    latestOutputSequence: integer("latest_output_sequence"),
    latestOutputText: text("latest_output_text"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
