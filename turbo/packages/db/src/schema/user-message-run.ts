import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { chatMessages } from "./chat-message";

/**
 * Associates immutable user chat messages with the run that claimed them.
 *
 * Assistant messages keep using chat_messages.run_id directly because they are
 * created with a known run. User messages route through this table so the
 * chat_messages row can remain append-only after it is inserted.
 */
export const userMessageRun = pgTable(
  "user_message_run",
  {
    userMessageId: uuid("user_message_id")
      .primaryKey()
      .references(
        () => {
          return chatMessages.id;
        },
        { onDelete: "cascade" },
      ),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_user_message_run_run_id").on(table.runId)];
  },
);
