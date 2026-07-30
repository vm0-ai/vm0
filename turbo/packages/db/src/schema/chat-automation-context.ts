import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatAutomationContext = pgTable(
  "chat_automation_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    automationId: uuid("automation_id").notNull(),
    triggerBrief: text("trigger_brief"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_automation_context_automation_id_idx").on(table.automationId),
    ];
  },
);
