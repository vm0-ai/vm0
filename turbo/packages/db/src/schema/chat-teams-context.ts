import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatTeamsContext = pgTable("chat_teams_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatThreadId: uuid("chat_thread_id")
    .notNull()
    .references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
  tenantId: text("tenant_id").notNull(),
  teamId: text("team_id"),
  channelId: text("channel_id"),
  conversationId: text("conversation_id").notNull(),
  conversationType: text("conversation_type"),
  activityId: text("activity_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
