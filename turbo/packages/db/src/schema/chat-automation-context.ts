import type { JsonObject } from "@vm0/db/jsonb-contracts/shared";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
    workflowName: text("workflow_name"),
    eventType: text("event_type"),
    /**
     * Server-private workflow automation launch material retained permanently.
     * Raw third-party content is intentionally retained as its only database
     * copy; read paths must project only explicitly required columns, and no
     * caller may project the entire row.
     */
    eventPayload: jsonb("event_payload").$type<JsonObject>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_automation_context_automation_id_idx").on(table.automationId),
    ];
  },
);
