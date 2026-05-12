import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { imessageUserLinks } from "./imessage-user-link";

/**
 * iMessage message store for context retrieval and webhook idempotency.
 */
export const imessageMessages = pgTable(
  "imessage_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: varchar("webhook_id", { length: 255 }),
    agentphoneMessageId: varchar("agentphone_message_id", {
      length: 255,
    }).notNull(),
    conversationId: varchar("conversation_id", { length: 255 }),
    agentphoneAgentId: varchar("agentphone_agent_id", {
      length: 255,
    }).notNull(),
    imessageUserLinkId: uuid("imessage_user_link_id").references(
      () => {
        return imessageUserLinks.id;
      },
      { onDelete: "set null" },
    ),
    phoneHandle: varchar("phone_handle", { length: 32 }).notNull(),
    fromNumber: varchar("from_number", { length: 32 }).notNull(),
    toNumber: varchar("to_number", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    body: text("body"),
    mediaUrl: text("media_url"),
    isBot: boolean("is_bot").default(false).notNull(),
    receivedAt: timestamp("received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_imessage_messages_agentphone_message").on(
        table.agentphoneMessageId,
      ),
      uniqueIndex("idx_imessage_messages_webhook_id")
        .on(table.webhookId)
        .where(sql`webhook_id IS NOT NULL`),
      index("idx_imessage_messages_handle_created").on(
        table.phoneHandle,
        table.createdAt,
      ),
      index("idx_imessage_messages_user_link").on(table.imessageUserLinkId),
    ];
  },
);
