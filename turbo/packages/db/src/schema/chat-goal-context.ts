import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatGoalContext = pgTable("chat_goal_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatThreadId: uuid("chat_thread_id")
    .notNull()
    .references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
  objectiveBrief: text("objective_brief").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
