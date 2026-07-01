import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

export const chatOutputMaterializations = pgTable(
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
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
